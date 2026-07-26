// SB-136 — the `Host` allowlist on the implicit local session. The api rung, which is the rung
// the ticket names: whether a request is answered is a property of a running server.
//
// WHAT IS BEING PROVEN. Under `personal` (SB-098) there is no cookie to be missing, so the
// loopback bind is the only thing between the API and a caller. Loopback stops another machine
// on the wifi. It does NOT stop a web page the user merely visited: DNS REBINDING makes an
// attacker domain that re-resolves to 127.0.0.1 same-origin to the browser, so there is no
// preflight to fail and no opaque response to hide behind, and the whole API is readable AND
// writable by that page. The `Host` header is the one thing the page cannot forge — it is the
// attacker's own domain — so a non-loopback `Host` is refused with 403.
//
// THE CONTRAST IS THE EVIDENCE, not a footnote. SB-099: Terje runs TWO instances on one machine,
// a personal one and a team demo with five real users. A Host check that leaked into `team`
// would 403 that demo the moment it were reached by any name other than localhost — which is
// what a company install is FOR. So every claim here is made twice, once against a `personal`
// server and once against a `team` server on the identical request, and the `team` half asserts
// the old behaviour byte for byte.
//
// WHY RAW SOCKETS. `Host` is a forbidden header name in `fetch` — undici refuses to set it, and
// a test that could not send `Host: evil.example` could not test this at all. Every request
// below is written onto a TCP socket by hand, which is also the only way to send NO Host header.
//
// ## Verified red-green: 2026-07-27 (output TRANSCRIBED from the runs, not reconstructed)
//   See the stanza above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { TT_DATA_DIR: data, TT_MD_DIR: join(data, 'mirror') };
}

/**
 * One HTTP/1.1 request, written by hand. The TCP connection always goes to 127.0.0.1 — that is
 * what a rebound browser does too, and it is the whole point: the packets are indistinguishable
 * and only the `Host` string differs.
 *
 * `host: null` OMITS the header entirely, which no browser does and which is therefore its own
 * case. `host: ''` sends it empty.
 */
function rawRequest(port, { method = 'GET', path = '/api/state', host, cookie, body, version = '1.1' } = {}) {
  return new Promise((ok, fail) => {
    const socket = connect(port, '127.0.0.1');
    socket.setTimeout(10000, () => {
      socket.destroy();
      fail(new Error(`raw ${method} ${path} (Host: ${host}) timed out`));
    });
    const lines = [`${method} ${path} HTTP/${version}`];
    if (host !== null) lines.push(`Host: ${host}`);
    if (cookie) lines.push(`Cookie: ${cookie}`);
    if (body !== undefined) {
      lines.push('Content-Type: application/json');
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    }
    lines.push('Connection: close', '', body ?? '');
    let raw = '';
    socket.on('data', (d) => (raw += d));
    socket.on('error', fail);
    socket.on('end', () => {
      const head = raw.split('\r\n\r\n')[0];
      const rest = raw.slice(head.length + 4);
      let json = null;
      try {
        json = JSON.parse(rest);
      } catch {
        /* not a JSON body */
      }
      ok({ status: +head.split('\r\n')[0].split(' ')[1], json, raw });
    });
    socket.end(lines.join('\r\n'));
  });
}

/** Log in over a raw socket and hand back the `tt_session…=…` pair to replay. */
async function loginCookie(port) {
  const res = await rawRequest(port, {
    method: 'POST',
    path: '/api/auth/login',
    host: `localhost:${port}`,
    body: JSON.stringify({ email: 'admin@timeturtle.local', password: 'testpw' }),
  });
  expect(res.status).toBe(200);
  const found = /set-cookie:\s*([^;\r\n]+)/i.exec(res.raw);
  expect(found, 'login returned no Set-Cookie — the team contrast below would prove nothing').toBeTruthy();
  return found[1];
}

const personal = (label) => ({ ...dataDir(label), TT_SHAPE: 'personal', TT_SEED_DEMO: '0' });

// ## Verified red-green: 2026-07-27, TRANSCRIBED.
//   ABSENCE — the `isLoopbackHostHeader` guard deleted from `requireUser`, i.e. the shipped
//   behaviour before this ticket — 4 of 7 fail, every one of them in this block, and the team
//   block below stays green throughout (it asserts that nothing changed, and nothing did):
//     FAIL  a personal server refuses a rebound request: Host evil.example gets 403
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  a rebound WRITE is refused, and stores nothing
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  the shapes of a Host header a real local client sends, and the ones it does not
//           AssertionError: Host "evil.example": expected 200 to be 403 // Object.is equality
//     FAIL  a real cookie still wins — the guard is on the implicit path and nowhere else
//           AssertionError: expected 200 to be 403 // Object.is equality
//
//   THE LOOSE PREDICATE — the mistake that looks like reuse, written the way somebody would
//   plausibly write it: strip the port with `.split(':')[0]` and hand the rest to the TT_HOST
//   predicate, `isLoopbackHost(String(req.headers.host || '').split(':')[0])`. 1 of 7 fails, and
//   it names both halves of why the two predicates are separate functions:
//     FAIL  the shapes of a Host header a real local client sends, and the ones it does not
//           AssertionError: Host "[::1]": expected 403 to be 200 // Object.is equality
//   …and with the two bracketed cases taken out of the accept list, the same test reds again on
//   the one that is not a parsing nicety but the attack itself — `/^127\./` is a PREFIX test and
//   that name is registrable:
//           AssertionError: Host "127.0.0.1.evil.example": expected 200 to be 403
describe('SB-136: the personal shape only answers a request addressed to loopback', () => {
  it('a personal server refuses a rebound request: Host evil.example gets 403', async () => {
    const server = await startServer(personal('rebind-personal'));

    // THE CONTROL. Same socket, same port, same absent cookie — the only difference in the two
    // requests is one header, so a 403 below cannot be the server being down or the path wrong.
    const local = await rawRequest(server.port, { host: `localhost:${server.port}` });
    expect(local.status).toBe(200);
    expect(local.json.user.id).toBe(1);
    expect(TT.shapeCapabilities(local.json.shape).identity).toBe(false);

    const rebound = await rawRequest(server.port, { host: 'evil.example' });
    expect(rebound.status).toBe(403);
    expect(rebound.json.error).toBe('this request was not addressed to localhost');
    // Nothing about the caller leaked back — not the timesheet, and not the Host it chose.
    expect(rebound.json.user).toBeUndefined();
    expect(rebound.raw).not.toMatch(/evil\.example/);

    await stopServer(server.child);
  }, 60000);

  it('a rebound WRITE is refused, and stores nothing', async () => {
    // The read is bad; the write is worse. A rebinding page that can PUT owns the timesheet.
    const server = await startServer(personal('rebind-write'));

    const entry = { id: 'e1-sb136', date: TT.todayStr(), start: 540, end: 600, project: null, label: 'rebound' };
    const put = await rawRequest(server.port, {
      method: 'PUT',
      host: 'evil.example',
      body: JSON.stringify({ entries: [entry] }),
    });
    expect(put.status).toBe(403);

    // And it really was refused, not merely answered oddly: the local read that DOES work sees
    // no such entry.
    const after = await rawRequest(server.port, { host: `localhost:${server.port}` });
    expect(after.status).toBe(200);
    expect(after.json.entries.map((e) => e.id)).not.toContain('e1-sb136');

    await stopServer(server.child);
  }, 60000);

  it('the shapes of a Host header a real local client sends, and the ones it does not', async () => {
    const server = await startServer(personal('rebind-shapes'));
    const p = server.port;

    // Accepted: what a browser, curl or the Vite dev proxy actually puts on the wire. The
    // bracketed IPv6 literal with a port is the one that is easy to parse wrong.
    for (const host of [
      'localhost',
      `localhost:${p}`,
      '127.0.0.1',
      `127.0.0.1:${p}`,
      '[::1]',
      `[::1]:${p}`,
      '127.0.0.2',
      `LOCALHOST:${p}`,
    ]) {
      const res = await rawRequest(p, { host });
      expect(res.status, `Host ${JSON.stringify(host)}`).toBe(200);
    }

    // Refused. `127.0.0.1.evil.example` is a real registrable name that a prefix test on "127."
    // would wave through, and it is exactly what a rebinding kit hands out.
    for (const host of [
      'evil.example',
      '127.0.0.1.evil.example',
      'localhost.evil.example',
      'notlocalhost',
      '192.168.1.10',
      '[::1].evil.example',
      '[::1',
      '', // present but empty
    ]) {
      const res = await rawRequest(p, { host });
      expect(res.status, `Host ${JSON.stringify(host)}`).toBe(403);
    }

    // NO HOST HEADER AT ALL. Under HTTP/1.1 this never reaches the guard: Node's own parser
    // rejects the request with a 400 before Express is handed it, because HTTP/1.1 requires the
    // header. Asserting 403 here would have been a lie about which layer refused. Under
    // HTTP/1.0, where the header is optional, the request DOES arrive with `req.headers.host`
    // undefined — and that is the branch `isLoopbackHostHeader` refuses on its own account.
    expect((await rawRequest(p, { host: null })).status).toBe(400);
    expect((await rawRequest(p, { host: null, version: '1.0' })).status).toBe(403);
    // …and the same HTTP/1.0 request WITH a local Host is answered, so the 403 above is the
    // missing header and not the protocol version.
    expect((await rawRequest(p, { host: 'localhost', version: '1.0' })).status).toBe(200);

    await stopServer(server.child);
  }, 60000);

  it('a real cookie still wins — the guard is on the implicit path and nowhere else', async () => {
    // DD-015's rule that a session surviving a `team → personal` switch keeps working. A page
    // that could produce an HMAC-signed cookie has already won by other means, so guarding the
    // cookie path would buy nothing and would break the switch.
    const server = await startServer({ ...dataDir('rebind-cookie'), TT_SHAPE: 'personal', TT_SEED_DEMO: '0' });
    const cookie = await loginCookie(server.port);

    expect((await rawRequest(server.port, { host: 'evil.example' })).status).toBe(403);
    expect((await rawRequest(server.port, { host: 'evil.example', cookie })).status).toBe(200);

    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-27, TRANSCRIBED. The mutation is THE LEAK — the guard hoisted
//   out of the `!identity` branch to the top of `requireUser`, so it applies to every shape,
//   which is the plausible-looking wrong place to put a security check:
//       function requireUser(req, res, next) {
//         if (!isLoopbackHostHeader(req.headers.host)) return res.status(403).json({ … });
//   3 of 7 fail. THREE OF THE FOUR PERSONAL TESTS ABOVE STAY GREEN under it — including both
//   403 claims — which is precisely why a suite that only proved the 403 would have shipped this
//   leak and taken the team demo's every-interface reachability down with it:
//     FAIL  a real cookie still wins — the guard is on the implicit path and nowhere else
//           AssertionError: expected 403 to be 200 // Object.is equality
//     FAIL  a team server is untouched: the same rebound request still gets its old 401
//           AssertionError: expected 403 to be 401 // Object.is equality
//     FAIL  a team install answers to its own name, which is what a team install is for
//           AssertionError: Host "timeturtle.office.local": expected 403 to be 200
//   The third test in this block stays green under that mutation BY DESIGN — every Host it sends
//   is loopback, because its subject is the shape hint and not the header. It is the bypass pin,
//   not a duplicate of the two above.
describe('SB-136: the team shape is untouched — the demo instance is reached by its own name', () => {
  it('a team server is untouched: the same rebound request still gets its old 401', async () => {
    const server = await startServer({ ...dataDir('rebind-team'), TT_SHAPE: 'team' });

    // 401, NOT 403. The distinction is the whole ticket: under `team` the answer to a cookieless
    // request is "who are you", and it does not become "go away" because of a header.
    const rebound = await rawRequest(server.port, { host: 'evil.example' });
    expect(rebound.status).toBe(401);
    expect(rebound.json.error).toBe('not authenticated');
    expect((await rawRequest(server.port, { host: `localhost:${server.port}` })).status).toBe(401);

    await stopServer(server.child);
  }, 60000);

  it('a team install answers to its own name, which is what a team install is for', async () => {
    // The colleague typing `http://timeturtle.office.local:3001` or an IP. A Host allowlist that
    // leaked into `team` would 403 every one of them, logged in or not.
    const server = await startServer({ ...dataDir('rebind-team-name'), TT_SHAPE: 'team' });
    const cookie = await loginCookie(server.port);

    for (const host of ['timeturtle.office.local', '192.168.1.91:3001', 'evil.example']) {
      const res = await rawRequest(server.port, { host, cookie });
      expect(res.status, `Host ${JSON.stringify(host)}`).toBe(200);
      expect(res.json.shape).toBe('team');
    }

    await stopServer(server.child);
  }, 60000);

  it('a team server still ignores every shape a client can claim, Host or otherwise', async () => {
    // SB-098's bypass pin, re-run with a loopback Host: the new guard must not have become a
    // second way of asking to skip the challenge. A `personal` hint plus a perfect local Host is
    // still 401, because the shape is resolved server-side and the Host check only ever REFUSES.
    const server = await startServer({ ...dataDir('rebind-team-claim'), TT_SHAPE: 'team' });
    const p = server.port;

    expect((await rawRequest(p, { host: `localhost:${p}` })).status).toBe(401);
    expect((await rawRequest(p, { host: '127.0.0.1' })).status).toBe(401);
    expect((await rawRequest(p, { host: `[::1]:${p}`, path: '/api/state?shape=personal' })).status).toBe(401);
    expect((await rawRequest(p, { host: `localhost:${p}`, path: '/api/me' })).status).toBe(401);

    await stopServer(server.child);
  }, 60000);
});
