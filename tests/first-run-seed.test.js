// DD-024 clause 3 — a fresh install seeds no demo hours, and SB-146's trap stops existing.
//
// TWO CHANGES, ONE MECHANISM. `SEED_DEMO` inverts from opt-out to opt-in, and the demo half of
// `seedIfEmpty` moves out from behind the boot so the first-run answer can ask for it. Admin
// creation stays at boot, unconditionally — every join is keyed `user_id` and three guards assume
// the row exists.
//
// WHY THIS CLOSES SB-146 RATHER THAN FIXING IT. The trap is a SEQUENCING window: the seed runs at
// boot while the shape is still `default`, `TT.seedMd()` dates its entries at `T`, `T-1`, `T-2`,
// `T-7`, `T-8`, `T-9`, and the cutover is stamped seconds later when `personal` is stored. Eight
// rows land pre-cutover and DD-017 §1 correctly freezes them forever — demo data the person can
// never delete. Move the seed past the answer and the window is gone: under `personal` there is
// nothing to strand, under `team` there is no cutover to strand it against.
//
// SB-146's CANDIDATE 1 IS NOT BUILT, deliberately. Stamping the cutover before the seed makes the
// demo rows POST-cutover and therefore eligible to be written into real daily notes — DD-016's
// first named hazard, verbatim.
//
// THE ONLY TEST HERE THAT CAN SEE THE DEFAULT FLIP IS THE FIRST ONE. Every other server-spawning
// site in `tests/` and `tests-browser/` sets `TT_SEED_DEMO` explicitly, and so does
// `startServer`'s own default — so a green suite proves nothing about the unset case. That test
// passes `undefined`, which `child_process` drops from the child's environment entirely.
//
// ## Verified red-green: 2026-07-28
//   See the stanza above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer, stopAllServers, session } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { TT_DATA_DIR: data, TT_MD_DIR: join(data, 'mirror') };
}

/** A bare cookieless fetch — the first run takes no credential and neither does this. */
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

const answerFirstRun = (port, body) =>
  bare(port, '/api/first-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ## Verified red-green: 2026-07-28, TRANSCRIBED.
//   ABSENCE, before either change: 4 of the 5 fail, and the trap is visible in the numbers —
//     FAIL  a stock fresh install holds no fabricated hours at all
//           AssertionError: a stock install seeded 4 projects: expected 4 to be +0
//     FAIL  SB-146's repro cannot be constructed any more — there is no demo row to freeze
//           AssertionError: expected 12 to be +0   ← twelve demo rows, about to be frozen
//
//   RESTORING THE OPT-OUT DEFAULT (`process.env.TT_SEED_DEMO !== '0'`) — 3 fail, not 1. The third
//   is the team demo step, and its red is informative rather than incidental: with the boot
//   already seeding, `seedDemoContent()` finds projects and returns false, so the route reports
//   `demo: false` and the person who ASKED for demo content is told it did not happen.
//     FAIL  a stock fresh install holds no fabricated hours at all
//     FAIL  SB-146's repro cannot be constructed any more — there is no demo row to freeze
//     FAIL  under `team` the demo step seeds, and what it seeds is editable
//
//   RESTORING THE BOOT-TIME SEED (calling `seedDemoContent()` unconditionally at boot, i.e.
//   ignoring the answer) — the same 3, for the same reason.
describe('DD-024 clause 3: a fresh install is empty', () => {
  it('a stock fresh install holds no fabricated hours at all', async () => {
    // `undefined` REMOVES the variable from the child's environment (child_process drops undefined
    // values), so this is the genuinely-unset case and not `TT_SEED_DEMO=''`. It is the one
    // assertion in the repo that can see the default flip — every other site passes the value.
    const server = await startServer({ ...dataDir('seed-unset'), TT_SEED_DEMO: undefined });

    const admin = session(server.port);
    const login = await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    expect(login.status, 'the admin user must still be created at boot — every join is keyed user_id').toBe(200);

    const state = await admin('GET', '/api/state');
    expect(state.status).toBe(200);
    expect(state.json.projects.length, `a stock install seeded ${state.json.projects.length} projects`).toBe(0);
    expect(state.json.clients.length).toBe(0);
    expect(state.json.entries.length).toBe(0);

    await stopServer(server.child);
  }, 60000);

  it('TT_SEED_DEMO=1 still seeds at boot, unregressed for every test and script that passes it', async () => {
    const server = await startServer({ ...dataDir('seed-optin'), TT_SEED_DEMO: '1' });

    const admin = session(server.port);
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    const state = await admin('GET', '/api/state');
    expect(state.json.projects.length).toBeGreaterThan(0);
    expect(state.json.entries.length).toBeGreaterThan(0);

    await stopServer(server.child);
  }, 60000);

  it("SB-146's repro cannot be constructed any more — there is no demo row to freeze", async () => {
    // The trap, in its own terms: answer `personal` on a fresh install and count what is now
    // frozen behind the cutover the answer stamps.
    const server = await startServer({ ...dataDir('seed-sb146'), TT_SEED_DEMO: undefined });

    expect((await answerFirstRun(server.port, { shape: 'personal' })).status).toBe(200);

    // Under `personal` the implicit local session answers, so no login is needed.
    const state = await bare(server.port, '/api/state');
    expect(state.status).toBe(200);
    expect(state.json.shape).toBe('personal');

    // BOTH HALVES, and the second is what makes the first mean anything. A count of 0 read alone
    // is 0 for any reason at all — including an install that never became `personal` and so never
    // stamped a cutover to be pre-cutover OF.
    const cutover = String(state.json.settings.vaultCutover || '');
    expect(cutover, 'no cutover was stamped, so this install never became personal').toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.json.entries.length).toBe(0);
    const cutoverDay = cutover.slice(0, 10);
    expect(state.json.entries.filter((e) => e.date < cutoverDay)).toEqual([]);

    await stopServer(server.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-28, TRANSCRIBED.
//   REMOVING THE `personal` REFUSAL from the route (honouring `demo: true` under either shape) —
//   exactly 1 fails, and nothing in the block above moves:
//     FAIL  demo content is not offered under `personal`, and asking for it is refused
//           AssertionError: expected 200 to be 403 // Object.is equality
describe('DD-024 clause 3: demo content is a step you ask for', () => {
  it('under `team` the demo step seeds, and what it seeds is editable', async () => {
    const server = await startServer({ ...dataDir('seed-team-demo'), TT_SEED_DEMO: undefined });

    const answered = await answerFirstRun(server.port, { shape: 'team', demo: true });
    expect(answered.status).toBe(200);
    expect(answered.json.demo).toBe(true);

    const admin = session(server.port);
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    const state = await admin('GET', '/api/state');
    expect(state.json.projects.length).toBeGreaterThan(0);
    expect(state.json.entries.length).toBeGreaterThan(0);

    // IT LANDED ON THE EDITABLE SIDE OF NOTHING, which is the half SB-146 was actually about.
    // Demo rows that cannot be deleted are worse than no demo rows.
    const keep = state.json.entries.slice(1);
    const saved = await admin('PUT', '/api/state', { entries: keep, version: state.json.version });
    expect(saved.status, 'a demo entry could not be deleted').toBe(200);
    const after = await admin('GET', '/api/state');
    expect(after.json.entries.length).toBe(keep.length);

    await stopServer(server.child);
  }, 60000);

  it('demo content is not offered under `personal`, and asking for it is refused', async () => {
    // Rook's provisional ruling, and the refusal is one condition — cheap for Terje to reverse.
    const server = await startServer({ ...dataDir('seed-personal-demo'), TT_SEED_DEMO: undefined });

    const refused = await answerFirstRun(server.port, { shape: 'personal', demo: true });
    expect(refused.status).toBe(403);

    // REFUSED, NOT HONOURED-AND-IGNORED: nothing was stored on the way to the refusal, so the
    // person can answer again rather than finding themselves in a shape they did not pick.
    const still = await bare(server.port, '/api/first-run');
    expect(still.json.open).toBe(true);

    await stopServer(server.child);
  }, 60000);
});
