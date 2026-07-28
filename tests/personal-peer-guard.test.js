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
async function bootOpenThenStore(label, shape, door = 'put') {
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

  const stored =
    door === 'shape'
      ? await admin('POST', '/api/shape', { shape })
      : await admin('PUT', '/api/state', { settings: { ...before.json.settings, shape } });
  expect(stored.status).toBe(200);
  expect((await admin('GET', '/api/state')).json.shape, 'the runtime store did not take').toBe(shape);
  return { server, admin, lanBefore };
}

// ## Verified red-green: 2026-07-28, TRANSCRIBED from the runs (full suite each time).
//
//   RE-MEASURED rather than carried over. These stanzas were first written on 2026-07-27 against
//   `7d2edf6`, where the file held five cases and the suite 819. DD-024 Amendment 1 added two
//   cases here and one more to this block, so every count below moved — carrying the old numbers
//   forward would have been three transcriptions describing a file that no longer exists.
//
//   (1) ABSENCE — the peer middleware neutered in `server/src/index.js`, i.e. the shipped
//   behaviour this ticket reports. All 5 cases in this block fail; the Amendment 1 block and the
//   team block stay green throughout. The first two ARE SB-162: a 200 with a full admin session
//   and no credentials, from the routable address.
//     FAIL  the LAN request that got a full admin session is refused — reads
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  a LAN WRITE is refused, and stores nothing
//     FAIL  the static client is refused from the LAN too, not just /api
//     FAIL  runs ahead of the body parser — a refused caller gets nothing buffered on its behalf
//           AssertionError: expected 400 to be 403 — the parser answered, which is the ordering
//           claim failing in the one direction that matters
//     FAIL  the refusal is the PEER guard, not SB-136’s Host check
//     Tests  5 failed | 827 passed (832)
//
//   (2) THE HOST CHECK DELETED INSTEAD — the proof the two guards are NOT redundant, which is
//   the thing a later "simplification" to one predicate would destroy. 5 fail: the four SB-136
//   cases plus the non-redundancy case in this file. Neither guard covers the other's subject,
//   and the two failure sets are disjoint except for that one deliberate overlap.
//     FAIL  host-rebinding › a personal server refuses a rebound request: Host evil.example…
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  host-rebinding › a rebound WRITE is refused, and stores nothing
//     FAIL  host-rebinding › the shapes of a Host header a real local client sends…
//     FAIL  host-rebinding › a real cookie still wins — the guard is on the implicit path…
//     FAIL  the refusal is the PEER guard, not SB-136’s Host check
//     Tests  5 failed | 827 passed (832)
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
    const { server, admin, lanBefore } = await bootOpenThenStore('peer-write', 'personal');
    // The same-server before/after this file's header claims as the evidence, asserted here too
    // and not only on the reads case (Reviewer, 2026-07-27). `rawRequest` rejects on
    // ECONNREFUSED, so an unreachable interface would already fail this case — but half the
    // stated evidence carried in only one of four places is a gap in the argument, not the code.
    expect(lanBefore.status).toBe(401);

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
    const { server, lanBefore } = await bootOpenThenStore('peer-static', 'personal');
    expect(lanBefore.status).toBe(401); // the interface answered before the shape moved

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
    // WHAT THIS DOES AND DOES NOT PROVE, said plainly, AND IT DEPENDS ON THE TREE (Reviewer,
    // 2026-07-27 — their checkout had `client/dist` and mine did not, so we read the same case
    // differently). It always proves the guard refuses a non-`/api` path: that it is app-wide
    // middleware and not an `/api` gate. Whether it ALSO proves ordering against `express.static`
    // depends on the control below:
    //
    //   • `client/dist` PRESENT (a built tree, and what `npm run test:browser` leaves behind) —
    //     the control is a 200 served by the static handler, so the LAN 403 does prove this
    //     middleware runs first.
    //   • `client/dist` ABSENT (the usual one; it is a build artefact) — the control is a 404 and
    //     the case is silent on ordering.
    //
    // Neither is asserted, because which one holds is a property of the checkout and pinning
    // either would make the case fail on the other. Ordering against `express.static` is
    // guaranteed structurally instead — the middleware is registered immediately after
    // `express()`, ~1400 lines ahead of the static handler — and ordering against `express.json`
    // is pinned for real by the case below.
    const local = await rawRequest('127.0.0.1', server.port, { path: '/', host: `localhost:${server.port}` });
    expect(local.status).not.toBe(403);

    await stopServer(server.child);
  }, 60000);

  it('runs ahead of the body parser — a refused caller gets nothing buffered on its behalf', async () => {
    expect(LAN, 'no routable IPv4 on this machine — the environment cannot decide this claim').toBeTruthy();
    const { server, lanBefore } = await bootOpenThenStore('peer-order', 'personal');
    expect(lanBefore.status).toBe(401);

    // THE ORDERING CLAIM IN THE GUARD'S OWN COMMENT, pinned rather than left structural: it is
    // registered ahead of `express.json` so a refused caller does not get up to 4mb buffered on
    // its behalf first. Proved with a MALFORMED body rather than a huge one — same question, no
    // multi-megabyte write to race a socket the server is closing early.
    //
    // `express.json` answers 400 on a body it cannot parse. So the two answers below are the two
    // possible orderings, on byte-identical requests that differ only in which peer sent them.
    const malformed = '{ this is not json';
    const local = await rawRequest('127.0.0.1', server.port, {
      method: 'PUT',
      host: `localhost:${server.port}`,
      body: malformed,
    });
    // the control: over loopback the guard passes, the parser runs, and it is the parser that
    // objects. Without this the LAN 403 below would be consistent with no parser at all.
    expect(local.status, 'the body parser did not run on the loopback control').toBe(400);

    const lan = await rawRequest(LAN, server.port, {
      method: 'PUT',
      host: `localhost:${server.port}`,
      body: malformed,
    });
    // 403 and not 400: the guard answered before the parser ever saw the body.
    expect(lan.status).toBe(403);
    expect(lan.json.error).toBe(PEER_REFUSAL);

    await stopServer(server.child);
  }, 60000);

  it('the refusal is the PEER guard, not SB-136’s Host check', async () => {
    expect(LAN, 'no routable IPv4 on this machine — the environment cannot decide this claim').toBeTruthy();
    const { server, lanBefore } = await bootOpenThenStore('peer-not-host', 'personal');
    expect(lanBefore.status).toBe(401); // the interface answered before the shape moved

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

// ============================================================================================
// DD-024 AMENDMENT 1 — the transition refusal, and WHICH `BIND_HOST` SUB-CASE IS WHICH
// ============================================================================================
//
// EVERY CASE ABOVE EXERCISES ONE SUB-CASE ONLY, and the file did not say so until now. `BIND_HOST`
// is `singleUserShape() ? HOST || '127.0.0.1' : HOST || undefined`, evaluated once at module load,
// and in the open state the `team` branch splits two ways:
//
//   • `TT_HOST` UNSET — `BIND_HOST` is `undefined`, every interface is bound, LOOPBACK AMONG
//     THEM. The peer guard refuses the LAN and the person keeps working over `localhost`. This is
//     Terje's own configuration, the common install, and the ONLY sub-case every case above uses
//     (`dataDir()` sets no `TT_HOST`). The guard is correct here and there is no hole.
//   • `TT_HOST` SET NON-LOOPBACK — `BIND_HOST` is that address and loopback is NEVER BOUND. After
//     the shape moves, every peer that can physically reach the socket is by construction not
//     loopback, so the peer guard refuses ALL of them. The process serves nobody, from anywhere,
//     for the rest of its life, while `tt` has printed a `http://localhost:<port>` that will not
//     connect and the only diagnostic says the request did not come from a machine it came from.
//     Found by Reviewer on this branch; the next restart does not rescue it either — the shape is
//     stored by then, so the boot refusal finally fires and the process exits 1.
//
// So the guard above is right in both and only one of them is a hole, and the hole is closed at
// the TRANSITION: storing `personal` is refused while the bind cannot serve loopback.
//
// CASE 2 IS THE ACCEPTANCE TEST, NOT A NICETY. Three guards in this cluster could not fire; a
// fourth that fires on everything is the same defect with the sign flipped. `TT_HOST` unset must
// return 200 and must keep serving loopback afterwards, or the common install is broken.
//
// ## Verified red-green: 2026-07-28, TRANSCRIBED from the runs (see the stanza below the block).
describe('DD-024 Amendment 1: the shape transition is refused when the bind cannot serve loopback', () => {
  /**
   * Boot bound ONLY to the routable address — `TT_HOST=<LAN>`, open state, so the boot refusal
   * cannot fire (`singleUserShape()` is false at module load) and loopback is never bound.
   *
   * The readiness probe has to ask the LAN address for the same reason: nothing is listening on
   * loopback, so the default probe would report "did not become ready" for a boot that worked.
   */
  async function bootBoundToLan(label) {
    const server = await startServer({ ...dataDir(label), TT_HOST: LAN }, { readyHost: LAN });
    const login = await rawRequest(LAN, server.port, {
      method: 'POST',
      path: '/api/auth/login',
      host: `localhost:${server.port}`,
      body: JSON.stringify({ email: 'admin@timeturtle.local', password: 'testpw' }),
    });
    expect(login.status, 'the LAN-bound server did not accept a login').toBe(200);
    const cookie = /set-cookie:\s*([^;\r\n]+)/i.exec(login.raw);
    expect(cookie, 'no Set-Cookie from the LAN-bound login — every case below would prove nothing').toBeTruthy();
    const jar = cookie[1];
    const ask = (opts) => rawRequest(LAN, server.port, { host: `localhost:${server.port}`, cookie: jar, ...opts });
    const state = await ask({});
    // The premise: open state, effective `team`, so the peer guard is not firing yet and the
    // install genuinely works from here. Without this a later 403 could be the peer guard.
    expect(state.status).toBe(200);
    expect(state.json.shape, 'the open-state boot must not already be personal').toBe('team');
    // And loopback really is unreachable — the condition the whole sub-case is about, measured
    // rather than assumed from `TT_HOST`.
    await expect(rawRequest('127.0.0.1', server.port, { host: `localhost:${server.port}` })).rejects.toThrow();
    return { server, ask, settings: state.json.settings };
  }

  it('CASE 1 — TT_HOST set to a routable address: answering `personal` is refused, at both doors', async () => {
    expect(LAN, 'no routable IPv4 on this machine — the environment cannot decide this claim').toBeTruthy();
    const { server, ask, settings } = await bootBoundToLan('bind-refuse');

    // DOOR ONE — `POST /api/shape`, which is the door DD-024's first run uses.
    const viaShape = await ask({ method: 'POST', path: '/api/shape', body: JSON.stringify({ shape: 'personal' }) });
    expect(viaShape.status).toBe(403);
    // The recovery line the boot refusal already gives, arriving at the one moment a human is
    // present to read it. Asserted as a substring so the sentence can be reworded but the
    // actionable half cannot be dropped.
    expect(viaShape.json.error).toContain('unset TT_HOST');
    expect(viaShape.json.error).toContain('personal');

    // DOOR TWO — `PUT /api/state`, the shared settings write. The two must not diverge; that is
    // the whole reason the code calls them a second door into one decision.
    const viaPut = await ask({
      method: 'PUT',
      body: JSON.stringify({ settings: { ...settings, shape: 'personal' } }),
    });
    expect(viaPut.status).toBe(403);
    expect(viaPut.json.error).toBe(viaShape.json.error);

    // NOTHING MOVED, and this is the assertion that separates a refusal from a 403 raised after
    // the write. Reviewer's serve-nobody state is what a stored `personal` here produces.
    const after = await ask({});
    expect(after.status).toBe(200);
    expect(after.json.shape).toBe('team');
    // …and the install still works from the address it is bound to, which is the point: the
    // person is left with a running server and a legible reason, not a brick.
    expect(after.json.user.role).toBe('admin');

    await stopServer(server.child);
  }, 60000);

  it('CASE 2 — TT_HOST unset: answering `personal` is ALLOWED, and loopback keeps working', async () => {
    // THE ACCEPTANCE TEST. `BIND_HOST` is `undefined` here, loopback IS bound, and the peer guard
    // is sufficient — so a refusal would break Terje's own install and every common first run.
    // Both doors again, because a predicate that is right on one and over-broad on the other is
    // exactly the divergence the two-doors comment exists to prevent.
    expect(LAN, 'no routable IPv4 on this machine — the environment cannot decide this claim').toBeTruthy();
    for (const door of ['put', 'shape']) {
      // `bootOpenThenStore` asserts the store returned 200 and that the shape actually moved, so
      // reaching this line at all is the 200 half of the case.
      const { server, admin, lanBefore } = await bootOpenThenStore('bind-allow-' + door, 'personal', door);
      expect(lanBefore.status).toBe(401);
      expect((await admin('GET', '/api/state')).json.shape, `stored via ${door}`).toBe('personal');

      // AND LOOPBACK STILL SERVES afterwards — the half that says the install is usable, not just
      // that a write returned 200. This is the state Reviewer measured as ECONNREFUSED in case 1.
      const local = await rawRequest('127.0.0.1', server.port, { host: `localhost:${server.port}` });
      expect(local.status, `loopback stopped answering after storing personal via ${door}`).toBe(200);
      expect(local.json.shape).toBe('personal');
      expect(local.json.user.role).toBe('admin'); // the implicit local session, working as designed

      await stopServer(server.child);
    }
  }, 120000);
});

// ## Verified red-green: 2026-07-28, TRANSCRIBED from the runs (full suite each time).
//
//   (4) THE TRANSITION REFUSAL NEUTERED — `bindRefusesLoopback()` forced to `false`, i.e. the
//   state Reviewer measured on `7d2edf6`. Exactly ONE fails, and its failure IS the serve-nobody
//   bug: the store returns 200, so the assertion that the shape did not move is the one that
//   catches it. Nothing else in the suite notices, which is precisely why it shipped once.
//     FAIL  CASE 1 — TT_HOST set to a routable address: answering `personal` is refused, at both doors
//           AssertionError: expected 200 to be 403 // Object.is equality
//     Tests  1 failed | 831 passed (832)
//   Case 2 stays green throughout, which is the point of having it: neutering the refusal cannot
//   be detected by the case that is supposed to be allowed.
//
//   (5) THE PREDICATE MADE OVER-BROAD — `BIND_HOST != null` dropped, so `undefined` refuses too.
//   The fourth-guard-fires-on-everything mistake, and the counts say how load-bearing that half
//   of the predicate is: TWENTY fail across EIGHT files.
//     Tests  20 failed | 812 passed (832)
//       4  tests/mirror-retire.test.js        1  tests/shape-choice.test.js
//       1  tests/mirror-slug-pin.test.js      1  tests/shape-inference.test.js
//       6  tests/personal-peer-guard.test.js  4  tests/shape-preflight.test.js
//       2  tests/shape-toggle.test.js         1  tests/vault-single-user.test.js
//     FAIL  CASE 2 — TT_HOST unset: answering `personal` is ALLOWED, and loopback keeps working
//           AssertionError: expected 403 to be 200 // Object.is equality
//   `TT_HOST` is unset in every one of those suites, so `String(undefined)` is `'undefined'`,
//   `isLoopbackHost` says no, and every runtime switch to `personal` in the codebase 403s.
//
//   I PREDICTED THREE AND MEASURED TWENTY, and the file carries the measurement rather than the
//   prediction. The gap is the finding: the `!= null` half is not a defensive nicety, it is the
//   difference between a guard and an outage.
//
//   Neither break is caught by the other's case, which is the property worth having.

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

// ## Verified red-green: 2026-07-28, TRANSCRIBED (re-measured — see the note on stanza 1).
//   The contrast, and it is the evidence rather than a footnote. SB-099: Terje runs a team demo
//   alongside the personal instance, and a LAN bind is what a company install is FOR.
//
//   (3) THE GUARD MADE UNCONDITIONAL — `singleUserShape() &&` dropped, the mistake that looks
//   like defence in depth. EIGHT fail, which is every LAN-touching case in this file: the
//   contrast below, and every case whose fixture probes the routable address BEFORE the shape
//   moves — those installs are still `team` at that moment, so an unconditional guard refuses
//   the control that makes the rest of the case mean anything.
//     FAIL  a team install still serves the LAN address — the guard must not leak
//           AssertionError: expected 403 to be 401 // Object.is equality
//     FAIL  the LAN request that got a full admin session is refused — reads
//     FAIL  a LAN WRITE is refused, and stores nothing
//     FAIL  the static client is refused from the LAN too, not just /api
//     FAIL  runs ahead of the body parser — a refused caller gets nothing buffered on its behalf
//     FAIL  the refusal is the PEER guard, not SB-136’s Host check
//     FAIL  CASE 1 — TT_HOST set to a routable address …  (its LAN login is refused outright)
//     FAIL  CASE 2 — TT_HOST unset: answering `personal` is ALLOWED …
//     Tests  8 failed | 824 passed (832)
//   It was 2 of 5 when this file was smaller; the shape of the result is unchanged and the
//   coverage is wider. The contrast case is still the one that names the defect.
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
