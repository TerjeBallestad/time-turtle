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
import { mkdtempSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer, stopAllServers, session } from './util.js';

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
