// DD-024 clause 1 / SB-158 — the first run answers without a credential, and only over loopback.
//
// The api rung, and it has to be: every claim here is a property of a RUNNING PROCESS. "A route
// answers with no cookie", "a socket from the wifi is refused", "the surface closes once the
// question is answered" — none of them exist inside a module import.
//
// WHAT MAKES THIS SURFACE SAFE, and why it takes three conditions rather than one:
//
//   1. THE OPEN STATE. `shapeTarget().source === 'default' && listUsers().length === 1` — the same
//      two conditions `shapeQuestionOpen` already resolves. An install that answered by env, by
//      lock or by a stored row has answered, and re-asking would overwrite what its operator typed.
//   2. THE PEER SOCKET, and this is the half that actually holds. In the open state the effective
//      shape is `team`, so `BIND_HOST` is `undefined` (server/src/index.js) and the server is on
//      EVERY INTERFACE. Loopback is not implied by anything here — it has to be checked.
//   3. THE HOST HEADER, unchanged from SB-136. It stops DNS rebinding in the user's own browser,
//      which arrives OVER LOOPBACK and is therefore invisible to condition 2.
//
// THE LAN CONTROL IS THE POINT OF THIS FILE. A refusal from the routable address WITHOUT a forged
// `Host: localhost` re-proves SB-136's header check and says nothing about the socket gate —
// SB-162 is the standing proof that a header check is not a peer check. So every LAN request below
// forges `Host: localhost`, and every one is paired with the byte-identical request to 127.0.0.1
// on the SAME server, so a refusal cannot be the interface being unreachable.
//
// WHY RAW SOCKETS. `Host` is a forbidden header name in `fetch` — undici refuses to set it. Same
// reason tests/host-rebinding.test.js writes its requests by hand; this one additionally has to
// choose which ADDRESS it connects to, which that file never needed.
//
// ## Verified red-green: 2026-07-28
//   See the stanza above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, session, seedVaultCatalog } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { TT_DATA_DIR: data, TT_MD_DIR: join(data, 'mirror') };
}

/** A fresh install in DD-015's OPEN STATE — nothing stored, no `TT_SHAPE`, and no demo hours. */
const open = (label) => ({ ...dataDir(label), TT_SEED_DEMO: '0' });

/**
 * THIS MACHINE'S ROUTABLE IPv4 — the address a colleague on the same wifi would type.
 *
 * IT THROWS RATHER THAN SKIPPING when there is none, and that is deliberate. A skipped LAN control
 * is a green suite that has not decided the claim, which is exactly how SB-162 shipped: the
 * refusal it needed was never asserted anywhere. An environment that cannot reach this machine
 * from a second address cannot answer the question, and it must say so out loud.
 */
function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  }
  throw new Error(
    'this environment has no non-loopback IPv4 address, so it cannot decide whether the peer gate ' +
      'refuses a LAN caller. Not skipped: a skipped LAN control is how SB-162 shipped.',
  );
}

/**
 * One HTTP/1.1 request written by hand, to a CHOSEN address with a CHOSEN `Host`.
 *
 * The two are independent on purpose. `connectTo` decides which socket the kernel reports to the
 * server as the peer; `host` decides the header. Forging `Host: localhost` on a connection from
 * the LAN is precisely the request Rook used against Terje's instance, and it is the only one that
 * can tell the peer gate apart from SB-136's header gate.
 */
function rawRequest(port, { connectTo = '127.0.0.1', method = 'GET', path = '/api/first-run', host, body } = {}) {
  return new Promise((ok, fail) => {
    const socket = connect(port, connectTo);
    socket.setTimeout(10000, () => {
      socket.destroy();
      fail(new Error(`raw ${method} ${path} to ${connectTo} (Host: ${host}) timed out`));
    });
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host ?? `localhost:${port}`}`];
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

/** A bare cookieless `fetch` — the jar is provably empty because there is no jar. */
const bare = async (port, path, init) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
};

const postFirstRun = (port, body) =>
  bare(port, '/api/first-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ## Verified red-green: 2026-07-28, TRANSCRIBED.
//   ABSENCE — before the routes existed, all 8 tests in this file fail (6 here, 2 in the peer
//   block below). The three shapes the absence takes, transcribed rather than tidied, because the
//   variety is what shows the tests are asserting different things:
//     FAIL  a fresh install serves the first run to a request carrying no credential at all
//           AssertionError: expected 404 to be 200 // Object.is equality
//     FAIL  answering the question closes the surface permanently
//           TypeError: Cannot read properties of null (reading 'open')
//     FAIL  a shape it does not recognise is refused, and nothing is stored
//           AssertionError: expected 404 to be 400 // Object.is equality
//   NEUTERED OPEN-STATE CONDITION — `firstRunOpen()` forced to `true`, i.e. the gate that closes
//   the surface once the question is answered removed. 3 of 6 fail:
//     FAIL  answering the question closes the surface permanently
//           AssertionError: expected true to be false // Object.is equality
//     FAIL  an install that already answered by env is never asked
//           AssertionError: expected true to be false // Object.is equality
//     FAIL  an install that grew a second user leaves the open state without a restart
//           AssertionError: expected true to be false // Object.is equality
describe('DD-024 clause 1: the first run answers without a credential', () => {
  it('a fresh install serves the first run to a request carrying no credential at all', async () => {
    const server = await startServer(open('first-run-open'));

    // A bare fetch, not tests/util.js's `session()` helper: the jar must be provably empty, and
    // the cheapest proof of that is not having one.
    const res = await bare(server.port, '/api/first-run');
    expect(res.status).toBe(200);
    expect(res.json.open).toBe(true);

    await stopServer(server.child);
  }, 60000);

  it('and `/api/state` is untouched — it still 401s in the open state', async () => {
    // The narrow-surface half of DD-024's deviation 1. Widening `/api/state` would make every
    // field it carries unauthenticated for the sake of one boolean.
    const server = await startServer(open('first-run-state-401'));

    expect((await bare(server.port, '/api/first-run')).status).toBe(200);
    const state = await bare(server.port, '/api/state');
    expect(state.status).toBe(401);
    expect(state.json.error).toBe('not authenticated');

    await stopServer(server.child);
  }, 60000);

  it('answering the question closes the surface permanently', async () => {
    const server = await startServer(open('first-run-closes'));

    expect((await bare(server.port, '/api/first-run')).json.open).toBe(true);

    const answer = await postFirstRun(server.port, { shape: 'personal' });
    expect(answer.status).toBe(200);
    expect(answer.json.shape).toBe('personal');

    // The open state is over — resolved from the STORED row, so this survives without a restart.
    const after = await bare(server.port, '/api/first-run');
    expect(after.status).toBe(200);
    expect(after.json.open).toBe(false);

    // …and the door is shut, not merely unreported. A second answer cannot overwrite the first.
    const again = await postFirstRun(server.port, { shape: 'team' });
    expect(again.status).toBe(409);

    // The answer really was stored, and it really was a PARTIAL settings write (SB-133): the
    // stored shape moved and nothing else in settings was flattened on the way.
    const admin = session(server.port);
    const state = await admin('GET', '/api/state');
    expect(state.status).toBe(200);
    expect(state.json.shape).toBe('personal');

    await stopServer(server.child);
  }, 60000);

  it('an install that already answered by env is never asked', async () => {
    // `source === 'env'`, not `default`. Re-asking would let a modal overwrite what an operator
    // typed on the command line.
    const server = await startServer({ ...dataDir('first-run-env'), TT_SHAPE: 'team', TT_SEED_DEMO: '0' });

    const res = await bare(server.port, '/api/first-run');
    expect(res.status).toBe(200);
    expect(res.json.open).toBe(false);
    expect((await postFirstRun(server.port, { shape: 'personal' })).status).toBe(409);

    await stopServer(server.child);
  }, 60000);

  it('an install that grew a second user leaves the open state without a restart', async () => {
    // DD-015's inference rule: more than one user has ANSWERED BY EXISTING. The boot rule that
    // stamps `team` runs once, so the count is re-checked per request — an install that adds a
    // second user mid-session must leave the open state immediately, not at the next restart.
    const server = await startServer(open('first-run-two-users'));
    expect((await bare(server.port, '/api/first-run')).json.open).toBe(true);

    // In the open state the effective shape is `team`, so this needs a real login.
    const admin = session(server.port);
    const login = await admin('POST', '/api/auth/login', {
      email: 'admin@timeturtle.local',
      password: 'testpw',
    });
    expect(login.status).toBe(200);
    const created = await admin('POST', '/api/users', {
      email: 'second@timeturtle.local',
      name: 'Second',
      password: 'testpw2',
      role: 'employee',
    });
    expect(created.status).toBe(200);

    expect((await bare(server.port, '/api/first-run')).json.open).toBe(false);
    expect((await postFirstRun(server.port, { shape: 'personal' })).status).toBe(409);

    await stopServer(server.child);
  }, 60000);

  it('a shape it does not recognise is refused, and nothing is stored', async () => {
    const server = await startServer(open('first-run-bad-shape'));

    expect((await postFirstRun(server.port, { shape: 'persona' })).status).toBe(400);
    // Still open, so nothing was stored on the way to the refusal.
    expect((await bare(server.port, '/api/first-run')).json.open).toBe(true);

    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-28, TRANSCRIBED.
//   ABSENCE, before the vault half existed — all 3 fail:
//     FAIL  the prefill rides on the same round trip, read from Obsidian's own registry
//           AssertionError: expected undefined to deeply equal [ … ]
//     FAIL  a personal answer stores the vault root it was given
//           AssertionError: expected '' to be '/var/folders/…/vault'
//     FAIL  a vault root that is not there is rejected, and stores NOTHING
//           AssertionError: expected 200 to be 400 // Object.is equality
//   REMOVING THE DIRECTORY VALIDATION — 1 fails, and it is the half-applied first run:
//     FAIL  a vault root that is not there is rejected, and stores NOTHING
//           AssertionError: expected 200 to be 400 // Object.is equality
describe('SB-140: the vault step knows where the vault is', () => {
  it('the prefill rides on the same round trip, read from Obsidian’s own registry', async () => {
    // FIXTURE registry, never the real one. `TT_OBSIDIAN_REGISTRY` exists for exactly this.
    const dir = mkdtempSync(join(tmpdir(), 'tt-first-run-registry-'));
    const vault = join(dir, 'ballestad');
    mkdirSync(vault, { recursive: true });
    const other = join(dir, 'Ideaverse');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(dir, 'obsidian.json'),
      JSON.stringify({ vaults: { a1: { path: other, ts: 300 }, b2: { path: vault, ts: 100, open: true } } }),
    );

    const server = await startServer({
      ...open('first-run-prefill'),
      TT_OBSIDIAN_REGISTRY: join(dir, 'obsidian.json'),
    });

    // ONE ROUND TRIP — the vault step costs no second endpoint.
    const res = await bare(server.port, '/api/first-run');
    expect(res.status).toBe(200);
    expect(res.json.open).toBe(true);
    expect(res.json.vaults.map((v) => v.name)).toEqual(['ballestad', 'Ideaverse']);
    expect(res.json.vaults[0].path).toBe(vault);
    // The fallback's fixed prefix rides along, so the client states one path rather than two.
    expect(res.json.vaultPrefix).toMatch(/iCloud~md~obsidian/);

    await stopServer(server.child);
  }, 60000);

  it('a personal answer stores the vault root it was given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tt-first-run-root-'));
    const vault = join(dir, 'ballestad');
    mkdirSync(vault, { recursive: true });
    const server = await startServer(open('first-run-root'));

    expect((await postFirstRun(server.port, { shape: 'personal', vaultRoot: vault })).status).toBe(200);

    // ASSERTED FROM THE STORE, not from the response: a route that answers 200 and stores nothing
    // is the exact failure this pairing exists to catch.
    const state = await bare(server.port, '/api/state');
    expect(state.status).toBe(200);
    expect(state.json.shape).toBe('personal');
    expect(state.json.settings.vaultPaths.root).toBe(vault);
    // Only `root` travels — the sub-paths keep their defaults.
    expect(state.json.settings.vaultPaths.daily).toBe('Calendar/Daily');

    await stopServer(server.child);
  }, 60000);

  it('a vault root that is not there is rejected, and stores NOTHING', async () => {
    // A HALF-APPLIED FIRST RUN IS WORSE THAN A REJECTED ONE. If the shape were stored and the
    // root refused, the person lands in a `personal` install with no vault, the open state is
    // over, and the step that would have fixed it is permanently closed.
    const server = await startServer(open('first-run-bad-root'));
    const missing = join(tmpdir(), 'tt-no-such-vault-' + Date.now());

    const res = await postFirstRun(server.port, { shape: 'personal', vaultRoot: missing });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain(missing); // it names the path, so the person can see the typo

    // The shape was NOT stored, and the question is still askable.
    const after = await bare(server.port, '/api/first-run');
    expect(after.json.open).toBe(true);

    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-28, TRANSCRIBED.
//   NEUTERED PEER PREDICATE — `isLoopbackPeer` forced to `return true`, which is what the surface
//   looks like with only SB-136's header check on it. Both tests in this block fail, and NOTHING
//   in the block above moves — which is the whole argument for this file having a LAN control at
//   all, and is the shape SB-162 shipped in:
//     FAIL  a LAN caller forging `Host: localhost` gets nothing, while loopback gets the surface
//           AssertionError: expected 200 to be 404 // Object.is equality
//     FAIL  the LAN caller cannot ANSWER the question either
//           AssertionError: expected 200 to be 404 // Object.is equality
describe('DD-024 clause 1: the gate is the peer socket, not the Host header', () => {
  it('a LAN caller forging `Host: localhost` gets nothing, while loopback gets the surface', async () => {
    const lan = lanAddress();
    const server = await startServer(open('first-run-lan'));

    // THE CONTROL, on the same server and the same port. The two requests differ in exactly one
    // thing — which address the socket came from — so a refusal cannot be the route being absent.
    const local = await rawRequest(server.port, { connectTo: '127.0.0.1', host: `localhost:${server.port}` });
    expect(local.status).toBe(200);
    expect(local.json.open).toBe(true);

    // The forged Host is what makes this a test of the SOCKET. Without it this only re-proves
    // SB-136's header check, which SB-162 already demonstrated is not a peer check.
    const remote = await rawRequest(server.port, { connectTo: lan, host: `localhost:${server.port}` });
    expect(remote.status, `LAN request from ${lan} was not refused`).toBe(404);
    expect(remote.json?.open).toBeUndefined();
    // A 404 rather than a 403: a refusal that confirms the surface exists is a refusal that
    // tells a scanner where to come back to.
    expect(remote.raw).not.toMatch(/first-run/);

    await stopServer(server.child);
  }, 60000);

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. Added by PLAN-016's end-gate review. DD-024
  //   clause 1 prices this route class on being "narrow and SELF-CLOSING", and only the POST was
  //   closing: the GET went on serving every Obsidian vault path on the machine, re-read from disk,
  //   to any unauthenticated loopback caller for the life of the install. Mutation — the `open ?`
  //   guards removed from the payload, i.e. the route as task 4 left it:
  //     FAIL  what it still says once the question is over is only what the login screen needs
  //           AssertionError: an answered install still reports the machine's vault list:
  //           expected [ { path: '/tmp/…', … } ] to have a length of +0 but got 1
  it('what it still says once the question is over is only what the login screen needs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tt-first-run-narrow-'));
    mkdirSync(join(dir, 'a-vault'));
    const registry = join(dir, 'obsidian.json');
    writeFileSync(registry, JSON.stringify({ vaults: { a: { path: join(dir, 'a-vault'), ts: 1, open: true } } }));
    // `TT_ADMIN_PASSWORD: ''` so the seeded admin carries the published default — the hint is the
    // one field that must SURVIVE the answer, and a server with its own password cannot show that.
    const server = await startServer({
      ...open('first-run-narrow'),
      TT_ADMIN_PASSWORD: '',
      TT_OBSIDIAN_REGISTRY: registry,
    });

    // WHILE OPEN it offers the vault, which is the whole point of carrying it.
    const before = await bare(server.port, '/api/first-run');
    expect(before.json.open).toBe(true);
    expect(before.json.vaults).toHaveLength(1);
    expect(before.json.vaultPrefix).toBeTruthy();

    expect((await postFirstRun(server.port, { shape: 'team' })).status).toBe(200);

    // AFTER the answer the prefill has no consumer — there is no vault step left to run — so it
    // stops being said. `defaultLogin` is the one field that survives, because the moment it is
    // needed IS the moment `open` is false: `team` closes the first run and lands the person on
    // `<Login>`.
    const after = await bare(server.port, '/api/first-run');
    expect(after.status).toBe(200);
    expect(after.json.open).toBe(false);
    expect(after.json.vaults, "an answered install still reports the machine's vault list").toHaveLength(0);
    expect(after.json.vaultPrefix).toBe('');
    expect(after.json.defaultLogin).not.toBeNull();

    await stopServer(server.child);
  }, 60000);

  it('the LAN caller cannot ANSWER the question either', async () => {
    // Read-only is not the claim. A LAN caller that could POST would choose the shape of an
    // install it does not own — and under `personal` that install then serves without a login.
    const lan = lanAddress();
    const server = await startServer(open('first-run-lan-post'));

    const body = JSON.stringify({ shape: 'personal' });
    const remote = await rawRequest(server.port, {
      connectTo: lan,
      host: `localhost:${server.port}`,
      method: 'POST',
      body,
    });
    expect(remote.status, `LAN POST from ${lan} was not refused`).toBe(404);

    // Nothing was stored: the install is still open, and the loopback control still works.
    const local = await rawRequest(server.port, { connectTo: '127.0.0.1', host: `localhost:${server.port}` });
    expect(local.status).toBe(200);
    expect(local.json.open).toBe(true);

    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-31, TRANSCRIBED. See the stanza above each case.
//
// DD-024 CLAUSE 2 — the credential the login screen may state back, and to whom.
//
// WHY IT RIDES ON THIS SURFACE AT ALL. This plan MOVED the shape question in front of the login,
// so a person who answers `Team` now lands on `<Login>` holding a password nobody ever showed them
// — `seedIfEmpty` announces it once on stdout, which `tt serve` redirects into a detached log file.
// The wall is this work's doing, so closing it is this work's job.
//
// AND WHY THE GATE IS THE SAME ONE. Under `team` the bind is EVERY INTERFACE (`BIND_HOST` is
// undefined), and task 2's peer middleware deliberately does not apply — a team install serving
// the network is what a team install is FOR. So the only thing standing between this credential
// and the wifi is `firstRunCaller`, the peer-socket + Host predicate. A Host-header-only gate here
// would be SB-162 with a password in it, and the browser rung structurally cannot see that: every
// Playwright page speaks from loopback.
describe('DD-024 clause 2: the starting-password hint, and who is allowed to read it', () => {
  /** An install whose admin still carries the password `server/src/config.js` publishes.
   *
   *  `TT_ADMIN_PASSWORD: ''` rather than omitting the key: `startServer` defaults it to `testpw`,
   *  and an empty string is falsy, so the server falls back to the published default exactly as an
   *  install with the variable unset does. An empty string also SURVIVES `child_process`, which
   *  drops `undefined` values.
   */
  const stock = (label) => ({ ...dataDir(label), TT_SEED_DEMO: '0', TT_ADMIN_PASSWORD: '' });

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE GATE WEAKENED — the GET handler's
  //   `firstRunCaller(req)` replaced by `isLoopbackHostHeader(req.headers.host)`, i.e. the hint
  //   gated on the Host header alone, which is the plausible wrong version and precisely SB-162's
  //   shape. 2 of 14 fail, and the pair is the point: the surface's own LAN case and this one both
  //   go, because they are the same gate — but only this one is about a credential.
  //     FAIL  a LAN caller forging `Host: localhost` gets nothing, while loopback gets the surface
  //           AssertionError: LAN request from 192.168.131.234 was not refused:
  //           expected 200 to be 404 // Object.is equality
  //     FAIL  the LAN cannot read it, not even with `Host: localhost` forged
  //           AssertionError: the LAN read the starting password from 192.168.131.234:
  //           expected 200 to be 404 // Object.is equality
  it('the LAN cannot read it, not even with `Host: localhost` forged', async () => {
    const lan = lanAddress();
    const server = await startServer(stock('first-run-hint-lan'));

    // THE CONTROL, byte-identical but for the socket it came from: over loopback the hint is there.
    const local = await rawRequest(server.port, { connectTo: '127.0.0.1', host: `localhost:${server.port}` });
    expect(local.status).toBe(200);
    expect(local.json.defaultLogin.email).toBe('admin@timeturtle.local');
    expect(local.json.defaultLogin.password).toBe('turtle');

    const remote = await rawRequest(server.port, { connectTo: lan, host: `localhost:${server.port}` });
    expect(remote.status, `the LAN read the starting password from ${lan}`).toBe(404);
    // Not merely absent from the parsed body — absent from the BYTES. A hint that leaks to the
    // wifi is worse than no hint, because the person who reads it is not the person who installed.
    expect(remote.raw).not.toMatch(/turtle/i);
    expect(remote.raw).not.toMatch(/admin@/);

    await stopServer(server.child);
  }, 60000);

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE SECRET LEAK — `defaultLoginHint()` changed
  //   to verify against `ADMIN_PASSWORD` (the env-aware value) and to report it, which is the
  //   version that looks more helpful and hands an operator's own secret to a screen:
  //   1 of 14 fails, and nothing else moves — the published-default cases cannot see this.
  //     FAIL  an operator who set their own password is told nothing — that one is a real secret
  //           AssertionError: an operator's own TT_ADMIN_PASSWORD was offered to the login screen:
  //           expected { …(2) } to be null
  it('an operator who set their own password is told nothing — that one is a real secret', async () => {
    const server = await startServer({ ...dataDir('first-run-hint-operator'), TT_ADMIN_PASSWORD: 'operatorpw' });

    const probe = await bare(server.port, '/api/first-run');
    expect(probe.status).toBe(200);
    expect(probe.json.defaultLogin, "an operator's own TT_ADMIN_PASSWORD was offered to the login screen").toBeNull();

    await stopServer(server.child);
  }, 60000);

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE STICKY HINT — `defaultLoginHint()` reduced
  //   to a boot-time boolean captured once instead of a per-request check against the stored hash,
  //   which is the shape that reads as an optimisation and turns a self-retiring note into a
  //   permanent one:
  //   1 of 14 fails, and the operator case above stays green under it — a cached `null` is still
  //   `null`, which is exactly why that case cannot stand in for this one.
  //     FAIL  it retires itself the moment the password changes
  //           AssertionError: the login screen still offers a password that no longer works:
  //           expected { …(2) } to be null
  it('it retires itself the moment the password changes', async () => {
    const server = await startServer(stock('first-run-hint-retires'));
    // Answer `team` first, because that is the branch the hint exists for: it closes the open state
    // and puts the login screen there.
    expect((await postFirstRun(server.port, { shape: 'team' })).status).toBe(200);
    expect((await bare(server.port, '/api/first-run')).json.defaultLogin.password).toBe('turtle');

    // The person does what the note tells them to do.
    const admin = session(server.port);
    expect(
      (await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'turtle' })).status,
    ).toBe(200);
    expect(
      (await admin('POST', '/api/me/password', { currentPassword: 'turtle', newPassword: 'something of theirs' }))
        .status,
    ).toBe(200);

    const after = await bare(server.port, '/api/first-run');
    expect(after.status).toBe(200);
    expect(after.json.defaultLogin, 'the login screen still offers a password that no longer works').toBeNull();

    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-31, TRANSCRIBED. See the stanza on the case.
//
// SB-140's LAST HALF, and it was FOUND BY BUILDING THE BROWSER FLOW rather than by reading the
// route: the first-run answer stored the vault root and left the sync engine where boot left it —
// pointed at nothing. `startVaultSync()` runs ONCE at module load, when a DD-024 install is still
// `team` with no vault, and both other doors that can store a shape or a path (`PUT /api/state`,
// `POST /api/shape`) already re-point it afterwards for exactly this reason. This one did not.
//
// The symptom is the one SB-063 cost this repo once: an install that looks wired up. The sidebar
// says `synced → vault`, the setting is stored, `/api/state` is correct in every field — and no
// watcher is on the vault until the person restarts the server, which nothing tells them to do.
//
// WHY THE EVIDENCE IS A NOTE PLACED BEFORE THE ANSWER. The boot scan cannot have imported it (there
// was no vault to scan), so an entry appearing in `/api/state` afterwards can ONLY have come from a
// scan the first-run route started. A note written after the answer would be ambiguous — the
// watcher and a later save would both explain it.
describe('DD-024 / SB-140: the first-run answer starts the vault sync engine', () => {
  // ## Verified red-green: 2026-07-31, TRANSCRIBED. ABSENCE — the `forgetOwnWrites()` +
  //   `startVaultSync()` block removed from `POST /api/first-run`, i.e. the route as task 4 left
  //   it. 1 of 15 fails, and it fails as the SYMPTOM rather than as a flag: the install is
  //   `personal`, the root is stored, and the vault it names is not being read.
  //     FAIL  a note already in the vault is read the moment the first run ends, not at the next
  //           restart
  //           AssertionError: the vault was never scanned after the answer — the sync engine is
  //           still pointed where boot left it: expected undefined to be 'from the other machine'
  it('a note already in the vault is read the moment the first run ends, not at the next restart', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'tt-first-run-sync-'));
    const dailyDir = join(vault, 'Calendar', 'Daily');
    mkdirSync(dailyDir, { recursive: true });
    // A CATALOG CARRYING A CUTOVER, which is what a vault the other machine already uses HAS
    // (DD-026 / PLAN-017 task 4). Without one the engine correctly stands down and imports
    // nothing, so this suite would be asserting the absence of a scan that was never owed. The
    // no-Catalog case is its own beat and its own question — that is task 5's.
    //
    // The day is TOMORROW rather than today, and the reason survives DD-026: the rule is
    // day-grained and a note dated today sits on the wrong side of a UTC-derived line for a few
    // hours a night in the western half of the world. Tomorrow is after it everywhere.
    const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    seedVaultCatalog(vault, { cutover: '2020-01-01' });
    const entry = {
      id: 'e1',
      date: day,
      start: 540,
      end: 600,
      durMin: null,
      project: null,
      task: null,
      label: 'from the other machine',
      note: '',
      bill: true,
    };
    writeFileSync(
      join(dailyDir, day + '.md'),
      `# ${day}\n\n## Intentions\n\nship it\n\n` +
        TT.serializeVaultBlock([entry], { heading: 'Time Log', revision: 4 }) +
        '\n\n## Captures\n\nnothing yet\n',
    );

    const server = await startServer(open('first-run-sync'));
    expect((await postFirstRun(server.port, { shape: 'personal', vaultRoot: vault })).status).toBe(200);

    // The scan is fire-and-forget, so poll rather than assert once — the response deliberately does
    // not wait for it (a cold vault takes minutes and the person is waiting on this screen).
    let entries = [];
    for (let i = 0; i < 100 && !entries.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      entries = (await bare(server.port, '/api/state')).json?.entries ?? [];
    }
    expect(
      entries[0]?.label,
      'the vault was never scanned after the answer — the sync engine is still pointed where boot left it',
    ).toBe('from the other machine');

    await stopServer(server.child);
  }, 60000);
});
