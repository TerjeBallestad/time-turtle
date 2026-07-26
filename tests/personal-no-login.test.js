// SB-098 items 1 and 2 — the two halves of "the personal shape has no login", and they only
// hold together. This is the api rung, and it is the rung the ticket names for these two:
// whether a request without a cookie is answered is a property of a running server, not of a
// rendered page.
//
// ITEM 1: under `personal`, `requireUser` resolves the single local user without a cookie
// challenge. ITEM 2: under `personal`, the listening socket is loopback-only, and a TT_HOST
// that would make it anything else is a refusal to start.
//
// THE CONTRAST IS THE MOST IMPORTANT ASSERTION IN THIS FILE, not a footnote. SB-099 established
// that Terje runs TWO instances on one machine — a personal one and a team demo with five real
// users. If the no-login gate leaked into `team`, the demo instance would lose authentication
// silently, and every single-server test in this file would still pass. So every claim below is
// made twice: once against a `personal` server, once against a `team` server on the same
// request, and the `team` half asserts the old behaviour is exactly as it was.
//
// AND THE GATE MUST NOT BE ASKABLE-FOR. The one thing that would turn this feature into a
// trivial auth bypass is a client-supplied shape reaching the decision, so the third block
// below sends a `team` server every shape hint a hand-rolled client could invent — header,
// query, body — and asserts it still 401s. `requireUser` reads `activeShape()`, which resolves
// from the env, the lock and the stored row and from nothing else; that is the property, and
// this is what pins it.
//
// ## Verified red-green: 2026-07-26 (output TRANSCRIBED from the runs, not reconstructed)
//   See the stanza above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn, runServerUntilExit } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { TT_DATA_DIR: data, TT_MD_DIR: join(data, 'mirror') };
}

/** A bare fetch with NO cookie jar — the whole point of item 1 is that there is nothing to send. */
async function anonymous(port, path, init = {}) {
  const res = await fetch(`http://localhost:${port}` + path, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * This machine's own non-loopback IPv4 — the address a colleague on the same wifi would type.
 *
 * READING THE BIND ARGUMENT PROVES NOTHING, which is why the loopback claim is made by
 * CONNECTING here and failing. A test that asserted `BIND_HOST === '127.0.0.1'` would pass
 * against a server that ignored the value entirely.
 *
 * It throws rather than skipping when there is no such address. A machine with no network is
 * one where the `team` contrast below cannot fail either, so a silent skip would leave a green
 * run that proved nothing at all — the exact evidence dishonesty this suite exists to avoid.
 */
function lanAddress() {
  const found = Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
  if (!found.length) {
    throw new Error(
      'no non-loopback IPv4 address on this machine — the loopback bind cannot be proven by ' +
        'connecting, and asserting it by reading the config would prove nothing. Run this on a ' +
        'networked machine.',
    );
  }
  return found[0];
}

/** Can this port be reached on `host` at all? A refused/timed-out connection resolves false. */
async function reachableOn(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/api/me`, { signal: AbortSignal.timeout(3000) });
    return !!res.status;
  } catch {
    return false;
  }
}

// ## Verified red-green: 2026-07-26, TRANSCRIBED.
//   ABSENCE — the implicit-session branch removed from `requireUser` (back to the plain 401),
//   i.e. the shipped behaviour before this ticket — 4 of 8 fail. Two are this block; the other
//   two are the bind block below, which uses the anonymous 200 as its CONTROL, so "unreachable"
//   can never quietly mean "never started":
//     FAIL  a personal server answers GET /api/state with no cookie at all
//           AssertionError: expected 401 to be 200 // Object.is equality
//     FAIL  the implicit session is the real user, and it can write
//           AssertionError: expected 401 to be 200 // Object.is equality
//     FAIL  a personal server cannot be reached from this machine’s own LAN address
//           AssertionError: expected 401 to be 200 // Object.is equality
//     FAIL  a loopback TT_HOST is honoured under personal rather than refused
//           AssertionError: expected 401 to be 200 // Object.is equality
//
//   THE LEAK — the branch made unconditional (`if (true)`, i.e. the `identity` capability check
//   dropped, so any shape resolves a lone user) — 2 of 8 fail, and both are the contrast:
//     FAIL  a team server refuses the same request — the demo instance keeps its login
//           AssertionError: expected 200 to be 401 // Object.is equality
//     FAIL  a team server ignores every shape a client can claim
//           AssertionError: expected 200 to be 401 // Object.is equality
//   Those two are what stand between SB-099's two instances and an unauthenticated company
//   timesheet, and they are red for exactly the mutation that would cause it.
describe('SB-098 item 1: the personal shape resolves a local session, and only the personal shape', () => {
  it('a personal server answers GET /api/state with no cookie at all', async () => {
    const env = dataDir('nologin-personal');
    const server = await startServer({ ...env, TT_SHAPE: 'personal', TT_SEED_DEMO: '0' });

    const state = await anonymous(server.port, '/api/state');
    expect(state.status).toBe(200);
    // …as the REAL seeded user, not an invented anonymous one. DD-015 depth 2: the user record,
    // the schema and every `user_id` join stay exactly as they are.
    expect(state.json.user.id).toBe(1);
    expect(state.json.user.email).toBe('admin@timeturtle.local');
    expect(state.json.user.role).toBe('admin');
    expect(state.json.shape).toBe('personal');
    // The client is told there is no identity surface here through the same table the commit
    // and mirror gates read — not through a second mechanism.
    expect(TT.shapeCapabilities(state.json.shape).identity).toBe(false);

    // /api/me too: it is the readiness probe AND the "who am I" call, and a login screen that
    // never renders is one that never asks.
    expect((await anonymous(server.port, '/api/me')).status).toBe(200);
    await stopServer(server.child);
  }, 60000);

  it('a team server refuses the same request — the demo instance keeps its login', async () => {
    // SB-099: two instances on one machine. This is the other one, and it holds five real users.
    const env = dataDir('nologin-team');
    const server = await startServer({ ...env, TT_SHAPE: 'team' });

    expect((await anonymous(server.port, '/api/state')).status).toBe(401);
    expect((await anonymous(server.port, '/api/me')).status).toBe(401);
    expect((await anonymous(server.port, '/api/state')).json.error).toBe('not authenticated');
    // A cookie still works there, so the 401 above is the auth check firing and not the server
    // being broken in some other way.
    const admin = await adminOn(server.port);
    expect((await admin('GET', '/api/state')).status).toBe(200);
    expect(TT.shapeCapabilities('team').identity).toBe(true);
    await stopServer(server.child);
  }, 60000);

  it('the implicit session is the real user, and it can write', async () => {
    // A read-only implicit session would be a half-shipped feature: the whole point is that a
    // person logs hours without signing in.
    const env = dataDir('nologin-write');
    const server = await startServer({ ...env, TT_SHAPE: 'personal', TT_SEED_DEMO: '0' });

    const entry = { id: 'e1-sb098', date: TT.todayStr(), start: 540, end: 600, project: null, label: 'no login' };
    const put = await anonymous(server.port, '/api/state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [entry] }),
    });
    expect(put.status).toBe(200);

    const after = await anonymous(server.port, '/api/state');
    expect(after.json.entries.map((e) => e.id)).toEqual(['e1-sb098']);
    // …and it landed on `user_id 1`, which is what makes DD-014's later personal → team import
    // have somewhere to land.
    expect(after.json.user.id).toBe(1);
    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-26, TRANSCRIBED. The mutation is the bypass itself — a
//   client-supplied hint reaching the decision, written the way somebody would plausibly write
//   it while "making the tests easier to run":
//       const claimed = req.headers['x-tt-shape'] || req.query.shape || (req.body || {}).shape;
//       if (!TT.shapeCapabilities(claimed || activeShape()).identity) { …resolve the lone user… }
//   1 of 8 fails — the header hint is the first of the three to be reached, so it is the one
//   the failure names, and removing it in turn reds the query and then the body:
//     FAIL  a team server ignores every shape a client can claim
//           AssertionError: expected 200 to be 401 // Object.is equality
//   With the shipped code all three hints are simply never read.
describe('SB-098 item 1: the gate keys off the effective shape and nothing a client sends', () => {
  it('a team server ignores every shape a client can claim', async () => {
    const env = dataDir('nologin-claim');
    const server = await startServer({ ...env, TT_SHAPE: 'team' });

    // A header.
    expect((await anonymous(server.port, '/api/state', { headers: { 'x-tt-shape': 'personal' } })).status).toBe(401);
    // A query parameter.
    expect((await anonymous(server.port, '/api/state?shape=personal')).status).toBe(401);
    // A body — on a PUT, which is the request that would actually change something.
    const put = await anonymous(server.port, '/api/state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shape: 'personal', settings: { shape: 'personal' }, entries: [] }),
    });
    expect(put.status).toBe(401);
    // And nothing it sent was stored on its way to being refused.
    const admin = await adminOn(server.port);
    expect((await admin('GET', '/api/state')).json.shape).toBe('team');
    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-26, TRANSCRIBED.
//   ABSENCE — `app.listen({ port: PORT, host: BIND_HOST })` put back to `app.listen(PORT)`,
//   i.e. the every-interface bind this ticket found — 2 of 8 fail:
//     FAIL  a personal server cannot be reached from this machine’s own LAN address
//           AssertionError: the personal server answered on 192.168.1.91 — an unauthenticated
//           timesheet is on the network: expected true to be false // Object.is equality
//     FAIL  a loopback TT_HOST is honoured under personal rather than refused
//           AssertionError: expected true to be false // Object.is equality
//   The TEAM halves stay green under that mutation, which is what makes them a contrast and not
//   a duplicate: they prove the address is real, the port is right and the probe can succeed, so
//   the personal failure is the bind and not the harness.
//
//   THE REFUSAL — the `TT_HOST` boot block gated off (`if (false)`) so a non-loopback bind is
//   merely ignored, which is the plausible-looking wrong fix — 1 of 8 fails:
//     FAIL  a personal shape refuses to start when TT_HOST would take it off loopback
//           Error: server did not exit within 15000ms — it started instead.
describe('SB-098 item 2: the loopback bind, proven by failing to connect', () => {
  it('a personal server cannot be reached from this machine’s own LAN address', async () => {
    const lan = lanAddress();

    const personalEnv = dataDir('bind-personal');
    const personal = await startServer({ ...personalEnv, TT_SHAPE: 'personal', TT_SEED_DEMO: '0' });
    // It IS up — on loopback, with no cookie, which is item 1 again and here it is the control:
    // "unreachable" has to mean "bound elsewhere", not "never started".
    expect((await anonymous(personal.port, '/api/state')).status).toBe(200);
    expect(
      await reachableOn(lan, personal.port),
      `the personal server answered on ${lan} — an unauthenticated timesheet is on the network`,
    ).toBe(false);
    await stopServer(personal.child);

    // THE CONTRAST. Same machine, same address, same probe — a team server answers there,
    // because a company install is reached from other machines by definition. Without this the
    // assertion above would pass on a laptop with the wifi off.
    const teamEnv = dataDir('bind-team');
    const team = await startServer({ ...teamEnv, TT_SHAPE: 'team' });
    expect(await reachableOn(lan, team.port)).toBe(true);
    await stopServer(team.child);
  }, 60000);

  it('a personal shape refuses to start when TT_HOST would take it off loopback', async () => {
    // The ticket is explicit that this is not best-effort: clamping to loopback and logging a
    // line would leave the operator believing the box is reachable, and ignoring it silently is
    // the same failure. Refusing is the only reading that cannot be mistaken for working.
    const refused = await runServerUntilExit({ ...dataDir('bind-refuse'), TT_SHAPE: 'personal', TT_HOST: '0.0.0.0' });
    expect(refused.code).not.toBe(0);
    expect(refused.output).toMatch(/refusing to start/);
    expect(refused.output).toMatch(/loopback/);

    // A refused boot leaves NOTHING behind — it runs ahead of seedIfEmpty, the inference stamp,
    // the cutover stamp and the mirror sweep. No admin user was created on the way out.
    expect(refused.output).not.toMatch(/created admin user/);
  }, 60000);

  it('a team server binds every interface with the same TT_HOST — the refusal is the shape’s, not the variable’s', async () => {
    const lan = lanAddress();
    const server = await startServer({ ...dataDir('bind-team-host'), TT_SHAPE: 'team', TT_HOST: '0.0.0.0' });
    expect(await reachableOn(lan, server.port)).toBe(true);
    await stopServer(server.child);
  }, 60000);

  it('a loopback TT_HOST is honoured under personal rather than refused', async () => {
    // The refusal is about WHICH address, not about the variable existing. Someone pinning the
    // bind to 127.0.0.1 explicitly is agreeing with the rule, not fighting it.
    const server = await startServer({
      ...dataDir('bind-explicit'),
      TT_SHAPE: 'personal',
      TT_SEED_DEMO: '0',
      TT_HOST: '127.0.0.1',
    });
    expect((await anonymous(server.port, '/api/state')).status).toBe(200);
    expect(await reachableOn(lanAddress(), server.port)).toBe(false);
    await stopServer(server.child);
  }, 60000);
});
