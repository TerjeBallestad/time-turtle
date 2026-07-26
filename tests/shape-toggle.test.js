// SB-056 / SB-100: the instance-shape toggle — `Settings.shape`, `TT_SHAPE`, `TT_SHAPE_LOCK`.
//
// DC-002 isomorphic to the mirror lock, so this file is md-dir-lock.test.js's shape on
// purpose: SEVERAL REAL SERVERS, so "the shape is what changed it" is proven by CONTRAST
// rather than asserted about one server. A single server reporting `shape: 'personal'` proves
// only that a flag was reported.
//
// The load-bearing assertion is the ABSENT MIRROR FILE after a save that really landed
// (DD-011: the v2 `|`-mirror stops under `personal`). Every such test therefore also asserts
// the DATABASE took the write — otherwise a PUT failing for an unrelated reason would leave no
// mirror file either, and pass this suite while proving nothing.
//
// THE BACKEND IS NOT ON THE WIRE (DD-015). It is derived from the shape and never selected, so
// what is asserted here is the shape plus the BEHAVIOUR the derived backend produces — the
// mirror written or not written — which is the stronger of the two claims anyway.
//
// ## Verified red-green: 2026-07-26, RE-RUN by SB-100 under the new names (output TRANSCRIBED
//    from the run, not reconstructed — a renamed transcript that was not re-run is a lying
//    stamp. Each test stops at its FIRST failing assertion, which is what these are.)
//   Forcing `activeShape()` (server/src/backend.js) to `return 'team'` unconditionally —
//   4 of 8 fail:
//     FAIL  the personal server writes NO mirror file, while the team server writes one …
//           AssertionError: expected '/var/folders/9z/ct9q0qr50wq_yyq1h7ynq…' to be null
//     FAIL  reports the effective shape on /api/state
//           AssertionError: expected 'team' to be 'personal'
//     FAIL  a stored shape setting beats TT_SHAPE, and survives a restart
//           AssertionError: expected 'team' to be 'personal'
//     FAIL  beats a `personal` already stored in the database — the documented recovery
//           AssertionError: expected 'team' to be 'personal'
//   The first of those is the load-bearing one: the response really does hand back a mirror
//   path, i.e. the mirror keeps writing when the shape is not consulted.
//
//   Its ON-DISK companion (`mirrorFiles(PERSONAL.md)` empty) sits one line later, so no
//   mutation above reaches it — each stops at the response. The mutation that DOES is a store
//   that lies about itself: `store.mirror` under personal doing `writeMirror(user); return
//   null;`. That is the case the plan's fake_evidence note is really about — a null in the
//   response proves the response, not the disk — and it fails on the disk (2 of 8):
//     FAIL  the personal server writes NO mirror file, while the team server writes one …
//           AssertionError: expected [ 'timesheet-admin.md' ] to deeply equal []
//     FAIL  a stored shape setting beats TT_SHAPE, and survives a restart
//           AssertionError: expected [ 'timesheet-admin.md', …(1) ] to deeply equal []
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer, stopAllServers, adminOn, runServerUntilExit } from './util.js';

/** The .md files sitting in a mirror dir right now (the dir may not exist at all). */
function mirrorFiles(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : [];
}

/** A fresh data dir + its own mirror dir, so one server's files can never be another's. */
function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, md: join(data, 'mirror') };
}

/** Log one hour through the caller's own /api/state, and prove the DB took it. */
async function logAnHour(admin, id) {
  const state = await admin('GET', '/api/state');
  const entry = { id, date: '2026-07-26', start: 540, end: 600, project: null, label: 'toggle', note: '', billable: 1 };
  const put = await admin('PUT', '/api/state', { entries: [...state.json.entries, entry] });
  expect(put.status).toBe(200);
  // THE WRITE REALLY LANDED. Without this the absent-mirror assertions below would also pass
  // against a PUT that failed for some unrelated reason.
  const after = await admin('GET', '/api/state');
  expect(after.json.entries.some((e) => e.id === id)).toBe(true);
  return put;
}

const TEAM = dataDir('shape-team');
const PERSONAL = dataDir('shape-personal');
const LOCKED = dataDir('shape-locked');

let TEAM_PORT;
let PERSONAL_PORT;
let LOCKED_PORT;

beforeAll(async () => {
  const [team, personal, locked] = await Promise.all([
    // the contrast server: the repo default, nothing set
    startServer({ TT_DATA_DIR: TEAM.data, TT_MD_DIR: TEAM.md }),
    startServer({ TT_DATA_DIR: PERSONAL.data, TT_MD_DIR: PERSONAL.md, TT_SHAPE: 'personal' }),
    startServer({ TT_DATA_DIR: LOCKED.data, TT_MD_DIR: LOCKED.md, TT_SHAPE: 'team', TT_SHAPE_LOCK: '1' }),
  ]);
  TEAM_PORT = team.port;
  PERSONAL_PORT = personal.port;
  LOCKED_PORT = locked.port;
}, 30000);

afterAll(stopAllServers);

describe('TT_SHAPE', () => {
  it('the personal server writes NO mirror file, while the team server writes one from the same request', async () => {
    const teamAdmin = await adminOn(TEAM_PORT);
    const personalAdmin = await adminOn(PERSONAL_PORT);

    const teamPut = await logAnHour(teamAdmin, 'e1-team');
    const personalPut = await logAnHour(personalAdmin, 'e1-personal');

    // The contrast: the SAME request shape, one instance shape apart. This is also the only
    // evidence that the DERIVED backend is real — nothing reports it, the mirror shows it.
    expect(teamPut.json.mirror).toBeTruthy();
    expect(mirrorFiles(TEAM.md)).toEqual(['timesheet-admin.md']);

    expect(personalPut.json.mirror).toBe(null);
    expect(mirrorFiles(PERSONAL.md)).toEqual([]);
  });

  it('reports the effective shape on /api/state', async () => {
    const teamState = await (await adminOn(TEAM_PORT))('GET', '/api/state');
    expect(teamState.json.shape).toBe('team');
    expect(teamState.json.shapeLocked).toBe(false);

    const personalState = await (await adminOn(PERSONAL_PORT))('GET', '/api/state');
    expect(personalState.json.shape).toBe('personal');
    expect(personalState.json.shapeLocked).toBe(false);
  });

  it('refuses to start on an unknown TT_SHAPE rather than falling back to team', async () => {
    // A typo that silently means `team` is the worst reading available: the operator
    // believes the vault is live while the mirror keeps writing into it.
    const { code, output } = await runServerUntilExit({
      TT_DATA_DIR: dataDir('shape-typo').data,
      TT_SHAPE: 'persona',
    });
    expect(code).not.toBe(0);
    expect(output).toMatch(/persona/);
    expect(output).toMatch(/team, personal/);
  }, 30000);
});

describe('Settings.shape', () => {
  it('a stored shape setting beats TT_SHAPE, and survives a restart', async () => {
    const { data, md } = dataDir('shape-stored');
    // Started EXPLICITLY on team, so "the setting won" is a contest and not a default.
    const before = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(before.port);
    expect((await admin('GET', '/api/state')).json.shape).toBe('team');

    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } });
    expect(put.status).toBe(200);
    // It takes effect immediately — the resolution is read at call time, not cached at boot.
    expect((await admin('GET', '/api/state')).json.shape).toBe('personal');
    await stopServer(before.child);

    const after = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const restarted = await adminOn(after.port);
    expect((await restarted('GET', '/api/state')).json.shape).toBe('personal');
    // and the mirror is off for it, still, with TT_SHAPE saying otherwise
    const put2 = await logAnHour(restarted, 'e1-stored');
    expect(put2.json.mirror).toBe(null);
    expect(mirrorFiles(md)).toEqual([]);
  }, 40000);

  it('an unrecognised shape value never reaches the store', async () => {
    const admin = await adminOn(TEAM_PORT);
    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'persona' } });
    // Whitelisted, not rejected — the enum discipline vaultTimeSeparator already uses.
    expect(put.status).toBe(200);
    const after = await admin('GET', '/api/state');
    // SB-133: `undefined`, and this assertion got STRONGER rather than being relaxed. It used to
    // read `toBe('team')` — the defaulted value, which "stored team" and "nothing stored" both
    // produced, so it could not actually tell whether `persona` had reached the store. Absent is
    // the claim the test's own name makes.
    expect(after.json.settings.shape).toBeUndefined();
    expect(after.json.shape).toBe('team');
  });
});

describe('TT_SHAPE_LOCK', () => {
  it('rejects a change to the shape with 403, and the setting does not sneak in', async () => {
    const admin = await adminOn(LOCKED_PORT);
    const state = await admin('GET', '/api/state');
    expect(state.json.shapeLocked).toBe(true);

    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } });
    expect(put.status).toBe(403);
    expect(put.json.error).toMatch(/TT_SHAPE_LOCK/);

    const after = await admin('GET', '/api/state');
    // SB-133: same strengthening — "the setting does not sneak in" is now literally asserted
    // (nothing stored) instead of being read off a default that looks identical to a stored `team`.
    expect(after.json.settings.shape).toBeUndefined();
    expect(after.json.shape).toBe('team');
  });

  it('an unchanged settings object still saves 200 (the ride-along)', async () => {
    // Not a nicety: `useServerSync` re-queues any non-409 failure and retries every 4 s
    // forever, so a blanket 403 on the key would turn every currency edit into a toast loop.
    const admin = await adminOn(LOCKED_PORT);
    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, currency: 'EUR' } });
    expect(put.status).toBe(200);
    const after = await admin('GET', '/api/state');
    expect(after.json.settings.currency).toBe('EUR');
    // SB-133: nothing stored, before or after. This install runs on TT_SHAPE + the lock, and the
    // whole-object round trip that just happened did not turn either of those into a row.
    expect(after.json.settings.shape).toBeUndefined();
    expect(after.json.shape).toBe('team');
  });

  it('beats a `personal` already stored in the database — the documented recovery', async () => {
    // `TT_SHAPE_LOCK=1 TT_SHAPE=team` is the ONLY way out of an install whose stored setting
    // says `personal` and whose user table says otherwise (a copied data dir). It has to beat
    // the stored setting, not merely supply a default — a default LOSES to the setting, and
    // losing to the setting is the wedge.
    const { data, md } = dataDir('shape-recover');
    const before = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(before.port);
    const state = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } })).status).toBe(
      200,
    );
    expect((await admin('GET', '/api/state')).json.shape).toBe('personal');
    await stopServer(before.child);

    const after = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team', TT_SHAPE_LOCK: '1' });
    const recovered = await adminOn(after.port);
    const recoveredState = await recovered('GET', '/api/state');
    expect(recoveredState.json.shape).toBe('team');
    expect(recoveredState.json.shapeLocked).toBe(true);
    // The stored value is still `personal` — it is IGNORED, not rewritten. That matters: the
    // recovery must not silently destroy what the operator chose.
    expect(recoveredState.json.settings.shape).toBe('personal');
    // And team is really in force: the mirror writes again.
    const put = await logAnHour(recovered, 'e1-recover');
    expect(put.json.mirror).toBeTruthy();
    expect(mirrorFiles(md).length).toBeGreaterThan(0);
    // A PUT echoing that stored `personal` back is UNCHANGED, so it rides along rather than 403ing
    // — otherwise the recovered install could never save its settings at all.
    const echo = await recovered('PUT', '/api/state', {
      settings: { ...recoveredState.json.settings, currency: 'USD' },
    });
    expect(echo.status).toBe(200);
  }, 40000);
});
