// SB-162 / DD-024 clause 4 / PLAN-016 Task 2 — a `personal` install refuses every non-loopback
// PEER, for the life of the process. The api rung: whether a request is answered is a property
// of a running server, so every claim here is made against one.
//
// WHAT IS BEING PROVEN, and it was confirmed live on Terje's own machine before it was a test.
// `BIND_HOST` (`server/src/index.js`) is evaluated ONCE at module load. DD-024 moves the shape
// question AFTER boot, so on a personal install `singleUserShape()` is false at bind time,
// `BIND_HOST` is `undefined`, and the socket is on every interface for the life of the process —
// while the shape becomes `personal` seconds later and `requireUser`'s no-identity branch starts
// handing out an implicit admin session with no cookie. The only thing left in between is
// `isLoopbackHostHeader`, and a Host header is trivially forged:
//
//   curl -s -H 'Host: localhost' http://192.168.1.91:3002/api/state
//   200  {"user":{"id":1,…,"role":"admin"}, "shape":"personal", …}
//
// Full admin session, no credentials, from any machine on the wifi. Writes on the same footing,
// and under `personal` a write reaches the real daily notes.
//
// THE BOOT ORDER IS THE FIXTURE, and getting it wrong is the named fake evidence: an install
// booted with `TT_SHAPE=personal` binds loopback at module load and therefore CANNOT exhibit
// this bug. Every server below boots in the OPEN state with no `TT_SHAPE` — so the bind really
// is every-interface — and only then stores `personal` through the API, which is the path
// DD-024 makes standard.
//
// THE SAME-SERVER BEFORE/AFTER IS THE EVIDENCE. Each case asks the LAN address once BEFORE the
// shape is stored and once after, on one server, one socket, one port. The first answer proves
// the interface is genuinely reachable — without it a refusal afterwards could equally be a
// closed port, which would make every assertion here vacuous. The only variable between the two
// is the shape.
//
// THE FORGED `Host: localhost` IS NOT OPTIONAL. A LAN refusal without it only re-proves SB-136's
// header check and says nothing about the peer gate. Every LAN request below carries a Host the
// header check accepts, so the only thing that can refuse it is the peer address.
//
// WHY RAW SOCKETS. `Host` is a forbidden header name in `fetch` — undici refuses to set it — so
// a test that could not forge it could not test this at all. Same reason as
// `tests/host-rebinding.test.js`, whose shape this follows.
//
// ## Verified red-green: 2026-07-27 (output TRANSCRIBED from the runs, not reconstructed)
//   See the stanzas above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { isLoopbackPeer } from '../server/src/config.js';
import { startServer, stopServer, stopAllServers, adminOn } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { TT_DATA_DIR: data, TT_MD_DIR: join(data, 'mirror'), TT_SEED_DEMO: '0' };
}

/**
 * The machine's own routable IPv4 — the address another machine on the wifi would type.
 *
 * NEVER SKIPS. An environment with no routable interface cannot decide this claim either way,
 * and a green suite that silently proved nothing about a live admin hole is worse than a red
 * one that says so. The caller fails with that sentence instead.
 * @returns {string | null}
 */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses || []) if (address.family === 'IPv4' && !address.internal) return address.address;
  return null;
}
const LAN = lanAddress();

/**
 * One HTTP/1.1 request written by hand onto a TCP socket, to a chosen ADDRESS.
 *
 * `connectTo` is the address the packets actually go to and is the subject of every case here;
 * `host` is the `Host:` string, which is forged independently. Keeping them separate arguments
 * is the point — the pair (LAN address, loopback Host) is the attack.
 */
function rawRequest(connectTo, port, { method = 'GET', path = '/api/state', host, cookie, body } = {}) {
  return new Promise((ok, fail) => {
    const socket = connect(port, connectTo);
    socket.setTimeout(10000, () => {
      socket.destroy();
      fail(new Error(`raw ${method} ${path} to ${connectTo}:${port} (Host: ${host}) timed out`));
    });
    const lines = [`${method} ${path} HTTP/1.1`];
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

/** The refusal this ticket adds. Asserted as a literal so it cannot be confused with SB-136's. */
const PEER_REFUSAL = 'this request did not come from this machine';
/** SB-136's refusal, asserted by name so a test can prove WHICH guard fired. */
const HOST_REFUSAL = 'this request was not addressed to localhost';

/**
 * Boot in DD-015's OPEN STATE — no `TT_SHAPE`, so the effective shape is `team` and the socket
 * is bound to every interface — then store `shape` through the API the way DD-024's first run
 * will. Returns the server plus a LAN probe taken BEFORE the shape moved.
 */
async function bootOpenThenStore(label, shape) {
  const server = await startServer(dataDir(label));
  const admin = await adminOn(server.port);
  const before = await admin('GET', '/api/state');
  // The premise of the whole file: at bind time this install was NOT personal, which is exactly
  // why the socket is on every interface. An install that booted personal cannot show this bug.
  expect(before.json.shape, 'the open-state boot must not already be personal').toBe('team');

  // Taken BEFORE the shape moves, on the address the rest of the file uses. This is the control
  // that makes a later refusal mean something: it proves the port really is reachable from the
  // routable interface, so "refused" cannot quietly mean "nothing was listening there".
  const lanBefore = await rawRequest(LAN, server.port, { host: `localhost:${server.port}` });

  const put = await admin('PUT', '/api/state', { settings: { ...before.json.settings, shape } });
  expect(put.status).toBe(200);
  expect((await admin('GET', '/api/state')).json.shape, 'the runtime store did not take').toBe(shape);
  return { server, admin, lanBefore };
}

// ## Verified red-green: 2026-07-27, TRANSCRIBED from the runs (full suite each time).
//
//   (1) ABSENCE — the peer middleware neutered in `server/src/index.js`, i.e. the shipped
//   behaviour this ticket reports. 4 of 5 fail, all in this block, and the team block stays
//   green throughout. The first two ARE SB-162: a 200 with a full admin session and no
//   credentials, from the routable address.
//     FAIL  the LAN request that got a full admin session is refused — reads
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  a LAN WRITE is refused, and stores nothing
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  the static client is refused from the LAN too, not just /api
//           AssertionError: expected 404 to be 403 // Object.is equality
//     FAIL  the refusal is the PEER guard, not SB-136’s Host check
//           AssertionError: expected 200 to be 403 // Object.is equality
//     Tests  4 failed | 815 passed (819)
//   The 404 rather than 200 on the static case is `client/dist` being absent from this tree —
//   it is a build artefact. See that case's own comment for what it does and does not prove.
//
//   (2) THE HOST CHECK DELETED INSTEAD — the proof the two guards are NOT redundant, which is
//   the thing a later "simplification" to one predicate would destroy. 5 fail: the four SB-136
//   cases plus the non-redundancy case in this file. Neither guard covers the other's subject.
//     FAIL  host-rebinding › a personal server refuses a rebound request: Host evil.example…
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  host-rebinding › a rebound WRITE is refused, and stores nothing
//     FAIL  host-rebinding › the shapes of a Host header a real local client sends…
//     FAIL  host-rebinding › a real cookie still wins — the guard is on the implicit path…
//     FAIL  the refusal is the PEER guard, not SB-136’s Host check
//           AssertionError: expected 200 to be 403 // Object.is equality
//     Tests  5 failed | 814 passed (819)
describe('SB-162: a personal install that answered the shape question after boot refuses the LAN', () => {
  it('the LAN request that got a full admin session is refused — reads', async () => {
    expect(LAN, 'no routable IPv4 on this machine — the environment cannot decide this claim').toBeTruthy();
    const { server, lanBefore } = await bootOpenThenStore('peer-read', 'personal');

    // BEFORE: the interface answered. Under `team` with no cookie that is a 401 challenge — not a
    // 200, and not the peer refusal. Whatever it is, the packets arrived.
    expect(lanBefore.status).toBe(401);
    expect(lanBefore.json.error).not.toBe(PEER_REFUSAL);

    // THE CONTROL, after the switch: loopback still gets the implicit session, so a refusal from
    // the LAN below is about WHERE the request came from and nothing else. Same port, same absent
    // cookie, same forged-identical Host — only the peer address differs.
    const local = await rawRequest('127.0.0.1', server.port, { host: `localhost:${server.port}` });
    expect(local.status).toBe(200);
    expect(local.json.user.id).toBe(1);
    expect(local.json.user.role).toBe('admin');
    expect(local.json.shape).toBe('personal');

    // THE TICKET, reproduced: routable IPv4, forged Host the header check accepts, no cookie.
    const lan = await rawRequest(LAN, server.port, { host: `localhost:${server.port}` });
    expect(lan.status).toBe(403);
    expect(lan.json.error).toBe(PEER_REFUSAL);
    // Nothing leaked back — not the timesheet, not the user, and not the address it came from.
    expect(lan.json.user).toBeUndefined();
    expect(lan.raw).not.toMatch(new RegExp(LAN.replace(/\./g, '\\.')));

    await stopServer(server.child);
  }, 60000);

  it('a LAN WRITE is refused, and stores nothing', async () => {
    expect(LAN, 'no routable IPv4 on this machine — the environment cannot decide this claim').toBeTruthy();
    const { server, admin } = await bootOpenThenStore('peer-write', 'personal');

    // Read-only was never the claim. Under `personal` a write reaches the real daily notes.
    const entry = {
      id: 'lan-write',
      date: '2026-07-27',
      start: 540,
      end: 600,
      project: null,
      label: 'written from the wifi',
      note: '',
      billable: 1,
    };
    const lan = await rawRequest(LAN, server.port, {
      method: 'PUT',
      host: `localhost:${server.port}`,
      body: JSON.stringify({ entries: [entry] }),
    });
    expect(lan.status).toBe(403);
    expect(lan.json.error).toBe(PEER_REFUSAL);

    // Re-read over loopback: a 403 raised AFTER the write would look identical from outside.
    const after = await admin('GET', '/api/state');
    expect(after.json.entries.find((e) => e.id === 'lan-write')).toBeUndefined();

    await stopServer(server.child);
  }, 60000);

  it('the static client is refused from the LAN too, not just /api', async () => {
    expect(LAN, 'no routable IPv4 on this machine — the environment cannot decide this claim').toBeTruthy();
    const { server } = await bootOpenThenStore('peer-static', 'personal');

    // The guard is app-wide, ahead of the routes AND the static handler. Serving the client to
    // the LAN while refusing the API would hand out an app that then cannot talk to anything —
    // and it is the same bytes-to-the-wrong-network question either way.
    const lan = await rawRequest(LAN, server.port, { path: '/', host: `localhost:${server.port}` });
    expect(lan.status).toBe(403);
    expect(lan.json.error).toBe(PEER_REFUSAL);

    // The loopback control asserts NOT-403 rather than 200: whether `client/dist` exists is a
    // property of the checkout, not of this guard, so pinning 200 would make the case fail on a
    // tree that had never been built.
    //
    // WHAT THIS DOES AND DOES NOT PROVE, said plainly. It proves the guard refuses a non-`/api`
    // path — that it is app-wide middleware and not an `/api` gate. In a tree WITHOUT
    // `client/dist` (the usual one, it is a build artefact) the loopback control is a 404, so
    // the case does not additionally prove ordering against `express.static`; in a built tree it
    // is a 200 and does. The ordering is instead guaranteed structurally: the middleware is
    // registered at `server/src/index.js` immediately after `express()`, ahead of every `app.use`
    // and every route, including the static handler ~1400 lines below.
    const local = await rawRequest('127.0.0.1', server.port, { path: '/', host: `localhost:${server.port}` });
    expect(local.status).not.toBe(403);

    await stopServer(server.child);
  }, 60000);

  it('the refusal is the PEER guard, not SB-136’s Host check', async () => {
    expect(LAN, 'no routable IPv4 on this machine — the environment cannot decide this claim').toBeTruthy();
    const { server } = await bootOpenThenStore('peer-not-host', 'personal');

    // TWO GUARDS, TWO ATTACKS, and this case is what stops them being folded into one. The Host
    // header here is one SB-136 accepts, so if the peer guard did not exist this request would be
    // answered — which is precisely what Rook measured against the live instance.
    const forged = await rawRequest(LAN, server.port, { host: `localhost:${server.port}` });
    expect(forged.status).toBe(403);
    expect(forged.json.error).toBe(PEER_REFUSAL);
    expect(forged.json.error).not.toBe(HOST_REFUSAL);

    // …and the Host check still fires on its own subject, over loopback, where the peer guard
    // cannot help: a DNS-rebound browser request arrives from 127.0.0.1 like any other.
    const rebound = await rawRequest('127.0.0.1', server.port, { host: 'evil.example' });
    expect(rebound.status).toBe(403);
    expect(rebound.json.error).toBe(HOST_REFUSAL);

    await stopServer(server.child);
  }, 60000);
});

// The predicate's own boundaries. The api cases above prove the guard fires and does not leak,
// but they exercise whichever address form THIS machine's stack happens to hand Node — so two
// branches with silent failure modes would go unpinned. `::ffff:127.0.0.1` is what a dual-stack
// listener reports for a v4 peer, and getting it wrong refuses ALL loopback traffic on the setup
// most machines have; `127.0.0.1.evil.example` is the registrable name that a prefix test would
// accept, which is the mistake `config.js` already documents for the Host predicate.
describe('isLoopbackPeer — the forms the kernel actually hands over', () => {
  it('accepts every loopback spelling and refuses everything else', () => {
    for (const address of ['127.0.0.1', '127.0.0.2', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1'])
      expect(isLoopbackPeer(address), address).toBe(true);
    for (const address of [
      '192.168.1.91',
      '::ffff:192.168.1.91', // a v4-mapped ROUTABLE address — the unwrap must not imply loopback
      '10.0.0.1',
      'fe80::1%en0',
      '127.0.0.1.evil.example', // a name, not an address: a prefix test would accept it
      'localhost', // this predicate reads addresses, never names — resolution is not its job
      '127.0.0.256', // not a valid quad
      '',
      undefined,
      null, // an absent `remoteAddress` (destroyed socket) refuses rather than defaulting open
    ])
      expect(isLoopbackPeer(address), String(address)).toBe(false);
  });
});

// ## Verified red-green: 2026-07-27, TRANSCRIBED.
//   The contrast, and it is the evidence rather than a footnote. SB-099: Terje runs a team demo
//   alongside the personal instance, and a LAN bind is what a company install is FOR.
//
//   (3) THE GUARD MADE UNCONDITIONAL — `singleUserShape() &&` dropped, the mistake that looks
//   like defence in depth. TWO fail, not one, and the second is the useful surprise: the
//   before/after control in the personal block catches the leak as well, because that install is
//   still `team` at the moment it is probed. A reader who expected only the contrast block to
//   fire would have under-counted the coverage.
//     FAIL  the LAN request that got a full admin session is refused — reads
//           AssertionError: expected 403 to be 401 // Object.is equality
//     FAIL  a team install still serves the LAN address — the guard must not leak
//           AssertionError: expected 403 to be 401 // Object.is equality
//     Tests  2 failed | 817 passed (819)
describe('the team contrast: the guard must not leak into the shape that wants a LAN bind', () => {
  it('a team install still serves the LAN address — the guard must not leak', async () => {
    expect(LAN, 'no routable IPv4 on this machine — the environment cannot decide this claim').toBeTruthy();
    // The IDENTICAL runtime path — open-state boot, shape stored through the API — so the only
    // difference from the block above is which shape was stored.
    const { server } = await bootOpenThenStore('peer-team', 'team');

    // No cookie: the team shape answers with its normal challenge, NOT with the peer refusal.
    // That distinction is the whole assertion — a 401 here means the request was let through to
    // the auth layer, which is exactly what must keep happening.
    const anon = await rawRequest(LAN, server.port, { host: `localhost:${server.port}` });
    expect(anon.status).toBe(401);
    expect(anon.json.error).not.toBe(PEER_REFUSAL);

    // And with a real cookie the LAN caller is SERVED — the behaviour a company install depends
    // on, asserted rather than inferred from the absence of a 403.
    const login = await rawRequest(LAN, server.port, {
      method: 'POST',
      path: '/api/auth/login',
      host: `localhost:${server.port}`,
      body: JSON.stringify({ email: 'admin@timeturtle.local', password: 'testpw' }),
    });
    expect(login.status).toBe(200);
    const cookie = /set-cookie:\s*([^;\r\n]+)/i.exec(login.raw);
    expect(cookie, 'the team login returned no Set-Cookie — the case below would prove nothing').toBeTruthy();

    const served = await rawRequest(LAN, server.port, { host: `localhost:${server.port}`, cookie: cookie[1] });
    expect(served.status).toBe(200);
    expect(served.json.shape).toBe('team');

    await stopServer(server.child);
  }, 60000);
});
