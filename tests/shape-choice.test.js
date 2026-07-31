// SB-098 item 4's server half, and SB-139's channel — the two things the first-run question
// stands on, proven at the api rung because both are server decisions. The QUESTION itself
// (that a human meets a screen and can answer it) is the browser rung and lives in
// tests-browser/onboarding-shape.test.js; this file proves the machinery it sits on.
//
// TWO CLAIMS, and the first one is a trap SB-133's executor found the hard way.
//
// 1. `POST /api/shape` STORES AN ANSWER EQUAL TO THE SHAPE ALREADY IN FORCE. An install with
//    nothing stored resolves to an effective `team` (DD-015: `team` is the safe row), so a user
//    answering "my company's" is choosing the shape they are already effectively on. The
//    Settings toggle deliberately early-returns on exactly that gesture — correctly, for a
//    toggle — and DD-015 left this case open for SB-098 to close. If the first-run question had
//    been built on `setShape`, the `personal` answer would have worked and the `team` answer
//    would have stored nothing, left `shapeOpen` true and asked the user again. Which half
//    works is what makes that failure easy to ship and easy to miss.
//
// 2. `shapeOpen` IS RESOLVED SERVER-SIDE, and cannot be re-derived by the client. Since SB-133
//    the wire omits `settings.shape` when nothing is stored — but "nothing stored" is not
//    "unanswered": an install running `TT_SHAPE=team` stores nothing and has answered, and
//    re-asking it would let a modal overwrite what its operator typed on the command line. Only
//    `shapeTarget().source` can tell those apart, and it never leaves the server.
//
// SB-139's constraint is pinned here too: a REFUSAL on this channel must not wedge the client.
// `useServerSync` re-queues any non-409 failure and retries every 4 s forever, which is why the
// existing shape guards on `PUT /api/state` compare against the stored value instead of
// rejecting the key. Nothing debounced reaches `POST /api/shape`, so it refuses outright — and
// the test below proves the ordinary settings PUT still returns 200 straight after one.
//
// ## Verified red-green: 2026-07-26 (output TRANSCRIBED from the runs, not reconstructed)
//   See the stanza above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopServer, stopAllServers, session, adminOn } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, env: { TT_DATA_DIR: data, TT_MD_DIR: join(data, 'mirror') } };
}

/** The settings row AS STORED, with no server in the way — `/api/state` cannot answer this. */
function storedSetting(data, key) {
  const db = new DatabaseSync(join(data, 'timeturtle.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } finally {
    db.close();
  }
}

const EMPLOYEE = { email: 'second@timeturtle.local', name: 'Second', role: 'employee', password: 'secondpw' };

// ## Verified red-green: 2026-07-26, TRANSCRIBED.
//   THE TRAP — `POST /api/shape` given `setShape`'s early return, i.e. the first-run question
//   built on the toggle's rule (`if (shape === activeShape()) return res.json({ ok: true, … })`
//   ahead of the write) — 2 of 9 fail, and note that only the `team` half moves:
//     FAIL  answering `team` from the open state STORES team, even though team is already in force
//           AssertionError: expected null to be 'team' // Object.is equality
//     FAIL  answering closes the question — shapeOpen goes false and stays false across a restart
//           AssertionError: expected true to be false // Object.is equality
//   `answering personal from the open state stores personal` stays GREEN under that mutation,
//   which is the whole reason this trap is worth a test: the half that works is the half you
//   would test by hand.
describe('SB-098 item 4: the answer is stored even when it equals the shape already in force', () => {
  it('answering `team` from the open state STORES team, even though team is already in force', async () => {
    const { data, env } = dataDir('choice-team');
    const server = await startServer(env);
    const admin = await adminOn(server.port);

    // The open state: effective `team` by DEFAULT, with nothing stored and nobody asked.
    const before = await admin('GET', '/api/state');
    expect(before.json.shape).toBe('team');
    expect(before.json.shapeOpen).toBe(true);
    expect(before.json.settings.shape).toBeUndefined(); // SB-133: absent, not a defaulted echo
    expect(storedSetting(data, 'shape')).toBe(null);

    const chose = await admin('POST', '/api/shape', { shape: 'team' });
    expect(chose.status).toBe(200);
    expect(chose.json.shape).toBe('team');

    // THE ASSERTION. A compare-first gesture returns 200 here too and stores nothing.
    expect(storedSetting(data, 'shape')).toBe('team');
    await stopServer(server.child);
  }, 60000);

  it('answering `personal` from the open state stores personal', async () => {
    const { data, env } = dataDir('choice-personal');
    const server = await startServer({ ...env, TT_SEED_DEMO: '0' });
    const admin = await adminOn(server.port);
    expect((await admin('GET', '/api/state')).json.shapeOpen).toBe(true);

    expect((await admin('POST', '/api/shape', { shape: 'personal' })).json.shape).toBe('personal');
    expect(storedSetting(data, 'shape')).toBe('personal');
    // DD-016: whatever can store the shape stamps the cutover, and this channel is no exception —
    // putSettings does it, so no route can skip it.
    expect(storedSetting(data, 'shapeStamp')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await stopServer(server.child);
  }, 60000);

  it('answering closes the question — shapeOpen goes false and stays false across a restart', async () => {
    const { env } = dataDir('choice-closes');
    const first = await startServer(env);
    let admin = await adminOn(first.port);
    expect((await admin('GET', '/api/state')).json.shapeOpen).toBe(true);
    expect((await admin('POST', '/api/shape', { shape: 'team' })).status).toBe(200);
    // Immediately, without a reload of the process: the modal must not survive its own answer.
    expect((await admin('GET', '/api/state')).json.shapeOpen).toBe(false);
    await stopServer(first.child);

    // And a stored answer is an answer tomorrow too.
    const second = await startServer(env);
    admin = await adminOn(second.port);
    expect((await admin('GET', '/api/state')).json.shapeOpen).toBe(false);
    await stopServer(second.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-26, TRANSCRIBED. The mutation here is the CLIENT-SIDE
//   DERIVATION this field exists to replace — `shapeOpen: !store.getStoredShape()`, which is
//   everything the client itself can see since SB-133 and is what a reasonable person would
//   write instead of adding a wire field — 3 of 9 fail:
//     FAIL  an install that answered by TT_SHAPE is never asked
//           AssertionError: expected true to be false // Object.is equality
//     FAIL  TT_SHAPE_LOCK is an answer too
//           AssertionError: expected true to be false // Object.is equality
//     FAIL  a two-user install is never asked, and stops being asked the moment the second user exists
//           AssertionError: expected true to be false // Object.is equality
//   The first two installs store nothing and have answered — that is the distinction only the
//   server holds. The third fails on its RUNTIME half: the second user has just been created and
//   nothing is stamped until the next boot, so a stored-shape test goes on handing the question
//   to an install that has answered by existing.
describe('SB-098 item 4: who is asked, and who is never asked (DD-015)', () => {
  it('an install that answered by TT_SHAPE is never asked', async () => {
    const { data, env } = dataDir('open-env');
    const server = await startServer({ ...env, TT_SHAPE: 'team' });
    const admin = await adminOn(server.port);
    const state = await admin('GET', '/api/state');
    // Nothing is stored — the client cannot tell this apart from the open state, and that is
    // exactly why the server answers it.
    expect(storedSetting(data, 'shape')).toBe(null);
    expect(state.json.settings.shape).toBeUndefined();
    expect(state.json.shapeOpen).toBe(false);
    await stopServer(server.child);
  }, 60000);

  it('TT_SHAPE_LOCK is an answer too', async () => {
    const { env } = dataDir('open-lock');
    const server = await startServer({ ...env, TT_SHAPE: 'team', TT_SHAPE_LOCK: '1' });
    const admin = await adminOn(server.port);
    const state = await admin('GET', '/api/state');
    expect(state.json.shapeLocked).toBe(true);
    expect(state.json.shapeOpen).toBe(false);
    await stopServer(server.child);
  }, 60000);

  it('a two-user install is never asked, and stops being asked the moment the second user exists', async () => {
    const { env } = dataDir('open-two');
    const first = await startServer(env);
    const admin = await adminOn(first.port);
    // One user: the open state, in the same process.
    expect((await admin('GET', '/api/state')).json.shapeOpen).toBe(true);

    // DD-015: more than one user has answered the question by existing. The count is re-checked
    // per request, so this closes WITHOUT waiting for the boot rule to stamp on a restart.
    expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);
    expect((await admin('GET', '/api/state')).json.shapeOpen).toBe(false);
    await stopServer(first.child);

    // …and on the next boot SB-100's inference rule has stamped `team`, so it is closed twice over.
    const second = await startServer(env);
    expect((await (await adminOn(second.port))('GET', '/api/state')).json.shapeOpen).toBe(false);
    await stopServer(second.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-26, TRANSCRIBED. Mutation: the three guards deleted from the
//   route, leaving it a bare `putSettings({ shape })` — 2 of 9 fail:
//     FAIL  the channel refuses what the shared PUT refuses, and a refusal does not wedge the client
//           AssertionError: expected 200 to be 403 // Object.is equality
//     FAIL  an employee cannot choose the shape
//           AssertionError: expected 200 to be 403 // Object.is equality
//   `an employee cannot choose the shape` needs `requireAdmin` removed instead — 1 of 9 fails,
//   `AssertionError: expected 200 to be 403`. And the 400 half needs its own mutation: with the
//   `TT.SHAPES.includes` check dropped, `putSettings` silently ignores the unknown name and the
//   route answers on — 1 of 9 fails, `AssertionError: expected 403 to be 400` (the lock fires
//   first once the validation is gone). That ordering is itself the reading that matters: a
//   shape nobody can be on must be REFUSED, never accepted-and-discarded.
describe('SB-098 / SB-139: the channel refuses loudly, and a refusal cannot wedge the client', () => {
  it('the channel refuses what the shared PUT refuses, and a refusal does not wedge the client', async () => {
    const { env } = dataDir('choice-refuse');
    const server = await startServer({ ...env, TT_SHAPE: 'team', TT_SHAPE_LOCK: '1' });
    const admin = await adminOn(server.port);

    // DC-002: the lock is env-only and beats a write, on this channel exactly as on the PUT.
    const locked = await admin('POST', '/api/shape', { shape: 'personal' });
    expect(locked.status).toBe(403);
    expect(locked.json.error).toMatch(/TT_SHAPE_LOCK/);

    // A name that is not a shape is a 400, not a silently-ignored key.
    expect((await admin('POST', '/api/shape', { shape: 'persona' })).status).toBe(400);
    expect((await admin('POST', '/api/shape', {})).status).toBe(400);

    // SB-139's constraint, and the reason this is a POST and not a 403 on the settings PUT:
    // `useServerSync` re-queues any non-409 failure and retries every 4 s forever. The refusals
    // above are on a channel nothing retries, and the debounced save path is untouched by them.
    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, currency: 'EUR' } });
    expect(put.status).toBe(200);
    await stopServer(server.child);
  }, 60000);

  it('the channel refuses `personal` on a multi-user install (DD-006 direction 2)', async () => {
    const { data, env } = dataDir('choice-multi');
    const server = await startServer(env);
    const admin = await adminOn(server.port);
    expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);

    const refused = await admin('POST', '/api/shape', { shape: 'personal' });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/a vault belongs to one person/);
    // Nothing was written on the way to being refused — a stored `personal` here is a data dir
    // that cannot boot (direction 3).
    expect(storedSetting(data, 'shape')).toBe(null);
    await stopServer(server.child);
  }, 60000);

  it('an employee cannot choose the shape', async () => {
    // A role claim, so it needs an employee SESSION rather than a reading of the guard.
    const { data, env } = dataDir('choice-employee');
    const server = await startServer(env);
    const admin = await adminOn(server.port);
    expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);

    const employee = session(server.port);
    expect((await employee('POST', '/api/auth/login', { email: EMPLOYEE.email, password: EMPLOYEE.password })).status).toBe(200); // prettier-ignore
    const refused = await employee('POST', '/api/shape', { shape: 'team' });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('admin only');
    expect(storedSetting(data, 'shape')).toBe(null);
    await stopServer(server.child);
  }, 60000);
});
