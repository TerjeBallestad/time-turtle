// SB-133: the whole-object PUT must not be able to CHOOSE the instance shape.
//
// The defect, in three ordinary decisions composing badly: `getSettings().shape` defaults to
// `team` when nothing is stored (correct — `team` is DD-015's safe row); the client PUTs the
// WHOLE settings object, so the defaulted `team` it was handed on load is echoed straight back;
// and a stored value beats `TT_SHAPE` (SB-100's precedence, working as designed). An install
// started `TT_SHAPE=personal` therefore flipped itself to `team` the first time anyone saved
// anything on Settings → Vault — the backend derived to `sqlite` and the vault went quiet, with
// no error, no toast and no refusal anywhere.
//
// THE SEQUENCE IS THE TEST. A unit of the reducer proves nothing here: the bug lives entirely in
// the ROUND TRIP, in the difference between what the server SENDS and what it will ACCEPT back.
// So every case below boots a real server, does a real GET, and PUTs that exact object back over
// HTTP with only `vaultPaths` changed — the same bytes a browser would send after one keystroke
// in the Vault folder field.
//
// AND THE ASSERTION IS BEHAVIOURAL, not a flag. `shape: 'personal'` in the JSON only proves a
// flag was reported; the mirror is the thing the derived backend actually DOES (DD-011: the v2
// `|`-mirror stops under `personal` and keeps writing under `team`), so every case logs an hour
// afterwards and asserts which of those two happened — and asserts the DB took the write, or a
// PUT that failed for some unrelated reason would leave no mirror file either and pass.
//
// ## Verified red-green: 2026-07-26 (output TRANSCRIBED from the runs, not reconstructed).
//   Against the code as it stood BEFORE the fix — `stateFor()` sending `settings:
//   store.getSettings()`, defaulted `shape: 'team'` and all — 2 of 4 fail:
//     FAIL  a save that only touches vaultPaths leaves the install personal
//           AssertionError: expected 'team' to be 'personal'
//     FAIL  sends the STORED shape, not a defaulted one
//           AssertionError: expected 'team' to be undefined
//   Each test stops at its FIRST failing assertion, so the first of those never reaches the
//   line that matters most — the mirror. A SECOND unfixed run with the three assertions above
//   it deleted reaches it, and that is the one that cannot be argued with: a file on disk that
//   the personal shape must never write, written by a save that only changed a vault path.
//     FAIL  a save that only touches vaultPaths leaves the install personal
//           AssertionError: expected '/var/folders/9z/ct9q0qr50wq_yyq1h7ynq…' to be null
//           + Received: ".../tt-shape-echo-SHZgnC/mirror/timesheet-admin.md"
//   The other two cases PASS unfixed, and both are here as pins rather than as the bug: the
//   `setShape` repair direction was never broken (a stored `team` differs from the `personal`
//   being asked for, so it was never the early return that swallowed it), and `team` must go on
//   resolving from nothing stored on a multi-user box.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopServer, stopAllServers, adminOn, unfrozenDay } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  // A REAL directory for the vault root the cases below type in: a path that does not exist is
  // a path the sync engine declines to watch, and the save under test would be testing nothing.
  const vault = join(data, 'vault');
  mkdirSync(vault, { recursive: true });
  return { data, md: join(data, 'mirror'), vault };
}

/** The .md files sitting in a mirror dir right now (the dir may not exist at all). */
function mirrorFiles(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : [];
}

/**
 * The settings row AS STORED, read out of the data dir with the server still running.
 * `/api/state` cannot answer this on its own — that indistinguishability IS the bug — so the
 * row itself is read directly, read-only, the way shape-inference.test.js does it.
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

/** Log one hour through the caller's own /api/state, and prove the DB took it. */
async function logAnHour(admin, id) {
  const state = await admin('GET', '/api/state');
  // SB-161: off the cutover this install just reported, not a literal and not the clock — the
  // cases here run under `personal`, where a stale literal is pre-cutover and 403s before the
  // mirror can be asserted. See `unfrozenDay`.
  const entry = {
    id,
    date: unfrozenDay(state.json),
    start: 540,
    end: 600,
    project: null,
    label: 'echo',
    note: '',
    billable: 1,
  };
  const put = await admin('PUT', '/api/state', { entries: [...state.json.entries, entry] });
  expect(put.status).toBe(200);
  const after = await admin('GET', '/api/state');
  expect(after.json.entries.some((e) => e.id === id)).toBe(true);
  return put;
}

describe('the echoed default (SB-133)', () => {
  it('a save that only touches vaultPaths leaves the install personal', async () => {
    const { data, md, vault } = dataDir('shape-echo');
    // `TT_SHAPE=personal` and NOTHING stored — SB-099's two-instance recipe, exactly.
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    const admin = await adminOn(server.port);

    const state = await admin('GET', '/api/state');
    expect(state.json.shape).toBe('personal');

    // The first thing a new personal user does: type a vault path into Settings → Vault. The
    // client PUTs the whole settings object it was handed, with one key changed.
    const put = await admin('PUT', '/api/state', {
      settings: { ...state.json.settings, vaultPaths: { ...state.json.settings.vaultPaths, root: vault } },
    });
    expect(put.status).toBe(200);

    const after = await admin('GET', '/api/state');
    expect(after.json.shape).toBe('personal');
    // The path really did save — otherwise the line above would pass against a PUT that did nothing.
    expect(after.json.settings.vaultPaths.root).toBe(vault);
    // and NOTHING was stored: no row means the env still decides, which is the whole point.
    // `TT_SHAPE=team` on the next boot must still be how this operator changes their mind.
    expect(storedSetting(data, 'shape')).toBe(null);

    // and the vault backend is still in force — the mirror stays off (DD-011). This is the
    // assertion that cannot be satisfied by a flag: it is a file on disk that must not exist.
    const hour = await logAnHour(admin, 'e1-echo');
    expect(hour.json.mirror).toBe(null);
    expect(mirrorFiles(md)).toEqual([]);
    await stopServer(server.child);
  }, 40000);

  it('sends the STORED shape, not a defaulted one', async () => {
    const { data, md } = dataDir('shape-wire');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    const admin = await adminOn(server.port);

    // The wire carries what was CHOSEN. Absent is the OPEN state (DD-015) and it has to be
    // legible as absent, or the client cannot echo it back without inventing a choice.
    const state = await admin('GET', '/api/state');
    expect(state.json.settings.shape).toBeUndefined();
    // ...while the EFFECTIVE shape is reported as it always was, on its own field.
    expect(state.json.shape).toBe('personal');

    // Once something IS stored, the wire carries that — this field is not simply gone.
    expect((await admin('PUT', '/api/state', { settings: { shape: 'team' } })).status).toBe(200);
    const stamped = await admin('GET', '/api/state');
    expect(stamped.json.settings.shape).toBe('team');
    expect(stamped.json.shape).toBe('team');
    await stopServer(server.child);
  }, 40000);

  it('an install wrongly stamped team can be moved back — the repair path', async () => {
    const { data, md } = dataDir('shape-repair');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    const admin = await adminOn(server.port);

    // The state every install flipped by this bug is already in: `TT_SHAPE=personal`, a stored
    // `team` beating it, the mirror writing again. Stamped explicitly here, because the bug that
    // used to produce it is fixed.
    expect((await admin('PUT', '/api/state', { settings: { shape: 'team' } })).status).toBe(200);
    expect((await admin('GET', '/api/state')).json.shape).toBe('team');
    const flipped = await logAnHour(admin, 'e1-flipped');
    expect(flipped.json.mirror).toBeTruthy();

    // The repair gesture: the shape toggle, which PUTs the settings object with `shape` changed.
    const state = await admin('GET', '/api/state');
    const repair = await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } });
    expect(repair.status).toBe(200);
    expect((await admin('GET', '/api/state')).json.shape).toBe('personal');
    expect(storedSetting(data, 'shape')).toBe('personal');
    // and it took effect: the mirror stops again for the NEXT save.
    const before = mirrorFiles(md).length;
    const hour = await logAnHour(admin, 'e2-repaired');
    expect(hour.json.mirror).toBe(null);
    expect(mirrorFiles(md).length).toBe(before);
    await stopServer(server.child);
  }, 40000);

  it('a multi-user box with nothing stored still resolves to team', async () => {
    // The defaulting is CORRECT in its own right and must survive the fix (DD-015: `team` is the
    // safe row, and an unstamped multi-user box must never guess `personal`). A wire that omits
    // an unstored shape must not make that one bit less true — absent still READS as team.
    const { data, md, vault } = dataDir('shape-team-default');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(server.port);
    expect(
      (
        await admin('POST', '/api/users', {
          email: 'second@timeturtle.local',
          name: 'Second',
          role: 'employee',
          password: 'secondpw',
        })
      ).status,
    ).toBe(200);
    expect((await admin('GET', '/api/users')).json.users).toHaveLength(2);

    const state = await admin('GET', '/api/state');
    expect(state.json.shape).toBe('team');
    // Nothing is stored on this box — this is the DEFAULT resolving, not a row doing it.
    expect(storedSetting(data, 'shape')).toBe(null);

    const put = await admin('PUT', '/api/state', {
      settings: { ...state.json.settings, vaultPaths: { ...state.json.settings.vaultPaths, root: vault } },
    });
    expect(put.status).toBe(200);
    const after = await admin('GET', '/api/state');
    expect(after.json.shape).toBe('team');
    // and the mirror is on, which is what `team` MEANS
    const hour = await logAnHour(admin, 'e1-team-default');
    expect(hour.json.mirror).toBeTruthy();
    expect(mirrorFiles(md).length).toBeGreaterThan(0);
    await stopServer(server.child);
  }, 40000);
});
