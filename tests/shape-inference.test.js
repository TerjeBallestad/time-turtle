// SB-100: the two things that are NOT a rename — the boot-time inference rule (DD-015) and
// the cutover stamp (DD-016).
//
// THE INFERENCE RULE. "More than one user already exists → stamp `team` at boot, silently,
// never ask" (DD-015). An install with five users has answered the question by existing, so
// SB-098's first-run modal never has to render a refusal it cannot resolve.
//
// The stamp is invisible from /api/state on its own — `settings.shape` defaults to `team`
// whether or not a row exists, which is the whole reason `getStoredShape()` is a separate
// function. So it is proven TWO ways, and both are needed:
//   1. the SQLite row itself, read straight out of the data dir with the server stopped;
//   2. its CONSEQUENCE — a stored value beats `TT_SHAPE`, so a stamped install boots `team`
//      where an unstamped one would have taken `TT_SHAPE=personal` and refused to start.
// (2) is what makes (1) mean something: a settings row nobody consults is not a decision.
//
// AND THE OPPOSITE, which is the half a "stamp when there are users" implementation gets
// wrong: exactly one user leaves the OPEN state open (nothing stored, SB-098 still asks), and
// an install that has ANSWERED by env or by lock is never re-answered underneath its operator.
// `source` is what all three cases key off, not the user count alone.
//
// THE CUTOVER STAMP. Storing `shape: 'personal'` stamps `Settings.cutover` with the
// instant it happened, once, server-side. The vault never receives entries dated before it.
// ENFORCING that is SB-057's (there is no vault write yet to filter); stamping early is what
// makes the date honest — a switch that happens before enforcement exists still records when.
//
// ## Verified red-green: 2026-07-26 (output TRANSCRIBED from the runs, not reconstructed)
//   See the stanza above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopServer, stopAllServers, adminOn, runServerUntilExit } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, md: join(data, 'mirror') };
}

/**
 * The settings row AS STORED, read out of the data dir with no server in the way. `/api/state`
 * cannot answer this: `getSettings()` defaults `shape` to `team`, so "stamped team" and
 * "nothing stored" look identical there — and telling them apart is the entire claim.
 */
function storedSetting(data, key) {
  const db = new DatabaseSync(join(data, 'timeturtle.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } finally {
    db.close();
  }
}

/**
 * "The stamp is NOW, not some default" — said about the INSTANT, bracketed by the window the
 * test itself measured. `before` is read immediately before whatever stamps, `after`
 * immediately after the read that observes it.
 *
 * SB-143: this used to be `expect(stamped.slice(0, 10)).toBe(TT.todayStr())`, which compares a
 * UTC instant to a LOCAL day and so was red for every run between local midnight and UTC
 * midnight — two hours a night in CEST, deterministically, on a clean main. Bracketing the
 * instant is timezone-free AND strictly tighter than the day check it replaces: it pins the
 * stamp to milliseconds, so a default, a hardcoded date, or a stamp remembered from an earlier
 * run all still fail.
 */
function expectStampedDuring(stamped, before, after) {
  const at = Date.parse(stamped);
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(after);
}

const EMPLOYEE = { email: 'second@timeturtle.local', name: 'Second', role: 'employee', password: 'secondpw' };

/** A data dir holding two users, with the server stopped and NOTHING stamped in it yet. */
async function twoUserDataDir(label, env = {}) {
  const { data, md } = dataDir(label);
  const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, ...env });
  const admin = await adminOn(server.port);
  expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);
  expect((await admin('GET', '/api/users')).json.users).toHaveLength(2);
  await stopServer(server.child);
  // The first boot saw ONE user, so it cannot have stamped anything. Without this the tests
  // below would pass against an implementation that stamps on every boot.
  expect(storedSetting(data, 'shape')).toBe(null);
  return { data, md };
}

// ## Verified red-green: 2026-07-26, TRANSCRIBED from the runs.
//   ABSENCE — the whole SB-100 boot block gated off (`if (false)`) and putSettings' stamp call
//   removed, i.e. exactly the rename commit's behaviour — 3 of 7 fail:
//     FAIL  a two-user data dir boots stamped `team`, and the stamp then beats TT_SHAPE=personal
//           AssertionError: expected null to be 'team' // Object.is equality
//     FAIL  storing `personal` stamps the cutover with the instant it happened, once, server-side
//           AssertionError: expected '' to match /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\…/
//     FAIL  a boot into `personal` stamps it too — the env is a way in as much as the setting is
//           AssertionError: expected '' to match /^\d{4}-\d{2}-\d{2}T/
//
//   The row assertion is the one that stops the run, so it hides the CONSEQUENCE half. Re-run
//   with the same absence AND `expect(storedSetting(data, 'shape')).toBe('team')` deleted:
//     FAIL  a two-user data dir boots stamped `team`, and the stamp then beats TT_SHAPE=personal
//           Error: server on 49227 exited with code 1 before becoming ready
//   — the boot refusal firing, because with nothing stamped nothing beat TT_SHAPE=personal.
//   That is the assertion that makes the stamp a decision rather than a row.
describe('the inference rule (DD-015): more than one user has answered by existing', () => {
  it('a two-user data dir boots stamped `team`, and the stamp then beats TT_SHAPE=personal', async () => {
    const { data, md } = await twoUserDataDir('infer-two');

    // A plain boot. Nothing in the env, nothing stored — the OPEN state, against two users.
    const inferred = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(inferred.port);
    expect((await admin('GET', '/api/state')).json.shape).toBe('team');
    await stopServer(inferred.child);

    // 1. the row is really there.
    expect(storedSetting(data, 'shape')).toBe('team');
    // DD-016 scope: `team` stamps NO cutover. Nothing is read-only, nothing is filtered.
    expect(storedSetting(data, 'shapeStamp')).toBe(null);

    // 2. and it is a decision, not a decoration: a stored value beats TT_SHAPE. Unstamped,
    //    this exact call is the boot refusal (see vault-single-user.test.js direction 3) and
    //    startServer throws instead of returning.
    const after = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    const back = await adminOn(after.port);
    const state = await back('GET', '/api/state');
    expect(state.json.shape).toBe('team');
    expect(state.json.settings.shape).toBe('team');
    await stopServer(after.child);
  }, 60000);
});

// ## Verified red-green: 2026-07-26, TRANSCRIBED. These are the OVER-stamping guard, so their
//   red is a mutation of the shipped rule rather than its absence — an inference rule that
//   fires too widely passes the block above and fails only here.
//   Keying it on the user count alone (`if (db.listUsers().length > 1)`, dropping
//   `target.source === 'default'`) — 2 of 7 fail:
//     FAIL  an install that answered by env is never re-answered — and still refuses to boot
//           AssertionError: expected 'team' to be null // Object.is equality
//     FAIL  TT_SHAPE_LOCK means never ask and never stamp
//           AssertionError: expected 'team' to be null // Object.is equality
//   Keying it on the source alone (`if (target.source === 'default')`) — 2 of 7 fail:
//     FAIL  a two-user data dir boots stamped `team`, and the stamp then beats TT_SHAPE=personal
//           AssertionError: expected 'team' to be null // Object.is equality  (in twoUserDataDir:
//           the ONE-user first boot stamped, which the helper refuses to build on)
//     FAIL  one user leaves the OPEN state open — nothing is stamped, so SB-098 still gets to ask
//           AssertionError: expected 'team' to be null // Object.is equality
describe('the inference rule does not fire where it must not', () => {
  it('one user leaves the OPEN state open — nothing is stamped, so SB-098 still gets to ask', async () => {
    const { data, md } = dataDir('infer-one');
    const first = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(first.port);
    expect((await admin('GET', '/api/users')).json.users).toHaveLength(1);
    await stopServer(first.child);

    expect(storedSetting(data, 'shape')).toBe(null);

    // The consequence, and the reason the open state has to STAY open: with nothing stored,
    // TT_SHAPE still wins. An install stamped `team` behind the operator's back would come up
    // `team` here and quietly ignore what they asked for.
    const personal = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    expect((await (await adminOn(personal.port))('GET', '/api/state')).json.shape).toBe('personal');
    await stopServer(personal.child);
  }, 60000);

  it('an install that answered by env is never re-answered — and still refuses to boot', async () => {
    // Two users AND an explicit TT_SHAPE. The count says "team", but the operator has already
    // spoken, and overwriting that would turn the loud direction-3 refusal into silence.
    const { data, md } = await twoUserDataDir('infer-env', { TT_SHAPE: 'team' });
    const booted = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    await stopServer(booted.child);
    expect(storedSetting(data, 'shape')).toBe(null);

    // Still unstamped, so TT_SHAPE=personal still reaches the single-user guard and the
    // process still refuses to start. This is the assertion that makes the one above matter.
    const refused = await runServerUntilExit({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    expect(refused.code).not.toBe(0);
    expect(refused.output).toMatch(/refusing to start/);
  }, 60000);

  it('TT_SHAPE_LOCK means never ask and never stamp', async () => {
    const { data, md } = await twoUserDataDir('infer-lock', { TT_SHAPE: 'team', TT_SHAPE_LOCK: '1' });
    const locked = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team', TT_SHAPE_LOCK: '1' });
    const admin = await adminOn(locked.port);
    expect((await admin('GET', '/api/state')).json.shapeLocked).toBe(true);
    await stopServer(locked.child);
    // Whoever set the box up decided. Writing a row here would leave a stored value behind
    // that outlives the lock and starts winning the moment TT_SHAPE_LOCK is removed.
    expect(storedSetting(data, 'shape')).toBe(null);
  }, 60000);
});

// ## Verified red-green: 2026-07-26, TRANSCRIBED. The ABSENCE run is in the first stanza above
//   (both cutover tests fail there). The FIRST-STAMP-WINS half needs its own mutation, because
//   a re-stamping implementation passes absence: dropping the `if (row && row.value) return
//   row.value;` early-out from stampVaultCutover (server/src/db.js) — 1 of 7 fails:
//     FAIL  storing `personal` stamps the cutover with the instant it happened, once, server-side
//           AssertionError: expected '2026-07-26T13:51:20.557Z' to be '2026-07-26T13:51:19.450Z'
//   The two instants are 1.1 s apart because of the sleep below, and that is deliberate: the
//   FIRST time this mutation was run the gap was 4 ms, then 6 ms — a guard one clock tick from
//   passing. `team stamps nothing, ever` stays green under every mutation here, correctly:
//   there is nothing for any of them to get wrong when no personal shape is ever stored.
//
// ## Verified red-green: 2026-07-27, TRANSCRIBED. SB-143 replaced the "it is NOW" check in both
//   cutover tests (`stamped.slice(0, 10)` vs `TT.todayStr()`) with `expectStampedDuring`.
//   RED BY CLOCK, no faketime needed — the real wall clock at 00:21 CEST is inside the window
//   where the local day and the UTC day disagree, and the OLD assertions were failing there on a
//   clean main, 2 of 7:
//     FAIL  storing `personal` stamps the cutover with the instant it happened, once, server-side
//     FAIL  a boot into `personal` stamps it too — the env is a way in as much as the setting is
//           AssertionError: expected '2026-07-26' to be '2026-07-27' // Object.is equality
//   GREEN after the change, and green in FOUR timezones at that same instant — 7 of 7 under
//   TZ unset (CEST), TZ=UTC, TZ=Pacific/Kiritimati (UTC+14) and TZ=Pacific/Midway (UTC-11).
//   The old form is red in two of those four; that spread is the whole point.
//
//   AND IT IS TIGHTER, NOT QUIETER. Mutation: stamp `new Date(Date.now() - 60_000)` in
//   stampVaultCutover — a stamp one minute stale, on the SAME local day. The old assertion
//   passed it 7 of 7 (run under TZ=UTC so midnight could not confound the result); the new one
//   fails 2 of 7:
//     AssertionError: expected 1785104568579 to be greater than or equal to 1785104628578
//   A second mutation, the hardcoded default the comment names (`'2000-01-01T00:00:00.000Z'`),
//   also fails 2 of 7: expected 946684800000 to be greater than or equal to 1785104619868.
describe('the cutover stamp (DD-016)', () => {
  it('storing `personal` stamps the cutover with the instant it happened, once, server-side', async () => {
    const { data, md } = dataDir('cutover-store');
    const first = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(first.port);
    // No cutover on a fresh install: `''` is "it has not happened", the value nobody can mean.
    expect((await admin('GET', '/api/state')).json.settings.shapeStamp).toBe('');

    const state = await admin('GET', '/api/state');
    const before = Date.now();
    expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } })).status).toBe(
      200,
    );

    const stamped = (await admin('GET', '/api/state')).json.settings.shapeStamp;
    const after = Date.now();
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // an ISO instant
    expectStampedDuring(stamped, before, after); // …and it is NOW, not some default

    // THE SLEEP IS WHAT MAKES EVERY ASSERTION BELOW MEAN SOMETHING. All of them say "the stamp
    // did not move", and without a measurable gap a re-stamping implementation produces an
    // instant a few milliseconds later — measured at 4 ms and 6 ms against two mutations, i.e.
    // one unlucky clock tick from passing. A second of real time makes the two unmistakable.
    await new Promise((r) => setTimeout(r, 1100));

    // SERVER-OWNED. The client PUTs the whole settings object back on every save, so a stamp a
    // client can move is a stamp a client can erase — and the date it would erase is the one
    // deciding which of the user's days may reach the vault at all.
    const moved = await admin('GET', '/api/state');
    expect(
      (
        await admin('PUT', '/api/state', {
          settings: { ...moved.json.settings, cutover: '2000-01-01T00:00:00.000Z' },
        })
      ).status,
    ).toBe(200);
    expect((await admin('GET', '/api/state')).json.settings.shapeStamp).toBe(stamped);

    // Nor does a round trip through `team` and back re-stamp it. The FIRST cutover is the
    // honest one: re-stamping later would silently re-open history that was already excluded.
    let now = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...now.json.settings, shape: 'team' } })).status).toBe(200);
    now = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...now.json.settings, shape: 'personal' } })).status).toBe(
      200,
    );
    expect((await admin('GET', '/api/state')).json.settings.shapeStamp).toBe(stamped);
    await stopServer(first.child);

    // And it survives a restart, because a cutover that forgets itself is not a cutover.
    const second = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    admin = await adminOn(second.port);
    expect((await admin('GET', '/api/state')).json.settings.shapeStamp).toBe(stamped);
    await stopServer(second.child);
  }, 60000);

  it('a boot into `personal` stamps it too — the env is a way in as much as the setting is', async () => {
    // DD-016 words the rule as "storing `shape: 'personal'`", but `TT_SHAPE=personal` reaches
    // the same live vault without ever storing anything, and an unstamped vault store is one
    // with NO pre-cutover history at all — every entry eligible, which is the hazard inverted.
    const { data, md } = dataDir('cutover-boot');
    const before = Date.now();
    const personal = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    const admin = await adminOn(personal.port);
    const stamped = (await admin('GET', '/api/state')).json.settings.shapeStamp;
    const after = Date.now();
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expectStampedDuring(stamped, before, after);
    await stopServer(personal.child);

    // The SHAPE is still not stored — the boot stamped the date, it did not answer the
    // question on the operator's behalf. TT_SHAPE=team must still take this install back.
    expect(storedSetting(data, 'shape')).toBe(null);
    const back = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    expect((await (await adminOn(back.port))('GET', '/api/state')).json.shape).toBe('team');
    await stopServer(back.child);
  }, 60000);

  it('`team` stamps nothing, ever (DD-016 scope)', async () => {
    const { data, md } = dataDir('cutover-team');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(server.port);
    const state = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, currency: 'EUR' } })).status).toBe(
      200,
    );
    expect((await admin('GET', '/api/state')).json.settings.shapeStamp).toBe('');
    await stopServer(server.child);
    expect(storedSetting(data, 'shapeStamp')).toBe(null);
  }, 60000);
});
