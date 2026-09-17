// SB-136 — the `Host` allowlist on the first run. The api rung: whether a request is answered is
// a property of a running server.
//
// WHAT IS BEING PROVEN. The first run takes no credential, so the address checks are all that
// stand between it and a caller. The peer check stops another machine on the wifi. It does NOT
// stop a web page the user merely visited: DNS REBINDING makes an attacker domain that re-resolves
// to 127.0.0.1 same-origin to the browser, so the request arrives over loopback. The `Host` header
// is the one thing the page cannot forge — it is the attacker's own domain — so a non-loopback
// `Host` gets the same 404 an unknown route gets.
//
// THE CONTRAST IS THE EVIDENCE, not a footnote. A Host check that leaked into the rest of the API
// would refuse a team install the moment it were reached by any name other than localhost — which
// is what a team install is FOR. So the second block asserts the ordinary API still answers every
// name, with its ordinary 401 and 200.
//
// WHY RAW SOCKETS. `Host` is a forbidden header name in `fetch` — undici refuses to set it, and
// a test that could not send `Host: evil.example` could not test this at all. Every request
// below is written onto a TCP socket by hand, which is also the only way to send NO Host header.
//
// Edited when the shape concept was removed (SB-181): the allowlist used to guard the implicit
// local session of a personal install, which is gone. The same Host matrix now runs against the
// first run, the one surface left that takes no credential.
//
// ## Verified red-green: 2026-09-17
//   See the stanza above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer, stopAllServers, adminOn } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  return { TT_DATA_DIR: mkdtempSync(join(tmpdir(), 'tt-' + label + '-')) };
}

/** A bare fetch with NO cookie jar. */
async function anonymous(port, path, init = {}) {
  const res = await fetch(`http://localhost:${port}` + path, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
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

/** A fresh install with its first run still open. */
const fresh = (label) => ({ ...dataDir(label), TT_SEED_DEMO: '0' });

// ## Verified red-green: 2026-09-17, TRANSCRIBED. The Host half dropped from `firstRunCaller`
//   (`return isLoopbackPeer(req.socket.remoteAddress);`) — all 3 fail:
//     ×  a rebound request is refused: Host evil.example gets 404 on the first run
//        AssertionError: expected 200 to be 404 // Object.is equality
//     ×  a rebound WRITE is refused, and stores nothing
//        AssertionError: expected 200 to be 404 // Object.is equality
//     ×  the shapes of a Host header a real local client sends, and the ones it does not
//        AssertionError: Host "evil.example": expected 200 to be 404 // Object.is equality
describe('SB-136: the first run only answers a request addressed to loopback', () => {
  it('a rebound request is refused: Host evil.example gets 404 on the first run', async () => {
    const server = await startServer(fresh('rebind-first-run'));

    // THE CONTROL. Same socket, same port, no cookie — the only difference in the two requests is
    // one header, so a 404 below cannot be the server being down or the path wrong.
    const local = await rawRequest(server.port, { path: '/api/first-run', host: `localhost:${server.port}` });
    expect(local.status).toBe(200);
    expect(local.json.open).toBe(true);

    const rebound = await rawRequest(server.port, { path: '/api/first-run', host: 'evil.example' });
    expect(rebound.status).toBe(404);
    expect(rebound.json.error).toBe('not found');
    // Nothing about the install leaked back — not the open state, and not the Host it chose.
    expect(rebound.json.open).toBeUndefined();
    expect(rebound.raw).not.toMatch(/evil\.example/);

    await stopServer(server.child);
  }, 60000);

  it('a rebound WRITE is refused, and stores nothing', async () => {
    // The read is bad; the write is worse. A rebinding page that can answer the first run decides
    // what the install starts with.
    const server = await startServer(fresh('rebind-write'));

    const post = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/first-run',
      host: 'evil.example',
      body: JSON.stringify({ demo: true }),
    });
    expect(post.status).toBe(404);

    // And it really was refused, not merely answered oddly: the install is still open.
    const after = await rawRequest(server.port, { path: '/api/first-run', host: `localhost:${server.port}` });
    expect(after.status).toBe(200);
    expect(after.json.open).toBe(true);

    await stopServer(server.child);
  }, 60000);

  it('the shapes of a Host header a real local client sends, and the ones it does not', async () => {
    const server = await startServer(fresh('rebind-shapes'));
    const p = server.port;
    const path = '/api/first-run';

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
      const res = await rawRequest(p, { path, host });
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
      const res = await rawRequest(p, { path, host });
      expect(res.status, `Host ${JSON.stringify(host)}`).toBe(404);
    }

    // NO HOST HEADER AT ALL. Under HTTP/1.1 this never reaches the guard: Node's own parser
    // rejects the request with a 400 before Express is handed it, because HTTP/1.1 requires the
    // header. Under HTTP/1.0, where the header is optional, the request DOES arrive with
    // `req.headers.host` undefined — and that is the branch `isLoopbackHostHeader` refuses on its
    // own account.
    expect((await rawRequest(p, { path, host: null })).status).toBe(400);
    expect((await rawRequest(p, { path, host: null, version: '1.0' })).status).toBe(404);
    // …and the same HTTP/1.0 request WITH a local Host is answered, so the 404 above is the
    // missing header and not the protocol version.
    expect((await rawRequest(p, { path, host: 'localhost', version: '1.0' })).status).toBe(200);

    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-09-17, TRANSCRIBED. The contrast. The Host check copied to the top of
//   `requireUser`, so it guards every route — 2 of 3 fail:
//     ×  a team server is untouched: the same rebound request still gets its old 401
//        AssertionError: expected 404 to be 401 // Object.is equality
//     ×  a team install answers to its own name, which is what a team install is for
//        AssertionError: Host "timeturtle.office.local": expected 404 to be 200 // Object.is equality
describe('SB-136: the rest of the API is untouched — the install is reached by its own name', () => {
  it('a team server is untouched: the same rebound request still gets its old 401', async () => {
    const server = await startServer(dataDir('rebind-team'));

    // 401, NOT 403. The answer to a cookieless request is "who are you", and it does not become
    // "go away" because of a header.
    const rebound = await rawRequest(server.port, { host: 'evil.example' });
    expect(rebound.status).toBe(401);
    expect(rebound.json.error).toBe('not authenticated');
    expect((await rawRequest(server.port, { host: `localhost:${server.port}` })).status).toBe(401);

    await stopServer(server.child);
  }, 60000);

  it('a team install answers to its own name, which is what a team install is for', async () => {
    // The colleague typing `http://timeturtle.office.local:3001` or an IP. A Host allowlist that
    // leaked into the API would refuse every one of them, logged in or not.
    const server = await startServer(dataDir('rebind-team-name'));
    const cookie = await loginCookie(server.port);

    for (const host of ['timeturtle.office.local', '192.168.1.91:3001', 'evil.example']) {
      const res = await rawRequest(server.port, { host, cookie });
      expect(res.status, `Host ${JSON.stringify(host)}`).toBe(200);
    }

    await stopServer(server.child);
  }, 60000);

  // Moved from personal-no-login.test.js (SB-181).
  it('a team server refuses the same request — the demo instance keeps its login', async () => {
    const server = await startServer(dataDir('nologin-team'));

    expect((await anonymous(server.port, '/api/state')).status).toBe(401);
    expect((await anonymous(server.port, '/api/me')).status).toBe(401);
    expect((await anonymous(server.port, '/api/state')).json.error).toBe('not authenticated');
    // A cookie still works there, so the 401 above is the auth check firing and not the server
    // being broken in some other way.
    const admin = await adminOn(server.port);
    expect((await admin('GET', '/api/state')).status).toBe(200);
    await stopServer(server.child);
  }, 60000);
});
