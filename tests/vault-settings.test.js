// SB-056: the PERSISTENCE half of the vault settings surface — `Settings.vaultPaths` and the
// `vaultTimeSeparator` SB-063 shipped without a control.
//
// HONESTY NOTE, and it is the point of the task this file belongs to: a green run here proves
// the values round-trip and survive a restart. It proves NOTHING about a human being able to
// change them. That is precisely the state SB-063 has been in since it shipped — perfect
// plumbing, no control — so the control itself is judged at the browser rung, in the Settings
// view, and this file is explicitly only the other half.
//
// ## Verified red-green: 2026-07-26
//   Dropping the `vaultPaths` branch from putSettings (server/src/db.js):
//     FAIL  vaultPaths round-trips and survives a restart
//           AssertionError: expected 'Calendar/Daily' to be 'Journal/Days'
//   Dropping the reconstruction loop so the incoming object is stored verbatim:
//     FAIL  junk keys are dropped and non-strings are ignored
//           AssertionError: expected { …(6) } to not have property "nonsense"
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, md: join(data, 'mirror') };
}

// Read from core.js rather than restated: a hand-copied expectation would keep passing after
// SB-057/SB-058 add a key, which is exactly the drift this test should be catching.
const DEFAULTS = TT.VAULT_PATHS_DEFAULT;

describe('Settings.vaultPaths', () => {
  it('defaults on a fresh install, round-trips, and survives a restart', async () => {
    const { data, md } = dataDir('vault-paths');
    const first = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(first.port);
    expect((await admin('GET', '/api/state')).json.settings.vaultPaths).toEqual(DEFAULTS);

    const state = await admin('GET', '/api/state');
    const wanted = {
      root: '/Users/someone/Obsidian/ballestad',
      daily: 'Journal/Days',
      weekly: 'Journal/Weeks',
      catalog: 'Meta/Catalog.md',
    };
    expect(
      (await admin('PUT', '/api/state', { settings: { ...state.json.settings, vaultPaths: wanted } })).status,
    ).toBe(200);
    expect((await admin('GET', '/api/state')).json.settings.vaultPaths).toEqual(wanted);
    await stopServer(first.child);

    const second = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    admin = await adminOn(second.port);
    expect((await admin('GET', '/api/state')).json.settings.vaultPaths).toEqual(wanted);
    await stopServer(second.child);
  }, 40000);

  // DD-026 clause 5. The heading used to round-trip as `vaultPaths.timeLogHeading` and the case
  // above proved it there; it is a settings key of its own now, so the same claim is made here
  // rather than dropped. Renaming it is the whole reason it is configurable, so a test that never
  // renames it proves nothing about that.
  it('the time-log heading round-trips as a SETTING, and survives a restart', async () => {
    const { data, md } = dataDir('vault-heading');
    const first = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(first.port);
    expect((await admin('GET', '/api/state')).json.settings.timeLogHeading).toBe(TT.TIME_LOG_HEADING_DEFAULT);
    const state = await admin('GET', '/api/state');
    expect(
      (await admin('PUT', '/api/state', { settings: { ...state.json.settings, timeLogHeading: 'Timelogg' } })).status,
    ).toBe(200);
    expect((await admin('GET', '/api/state')).json.settings.timeLogHeading).toBe('Timelogg');
    // and it is NOT a path — a heading written into `vaultPaths` is one the other machine never
    // sees, which is two blocks in one note
    expect((await admin('GET', '/api/state')).json.settings.vaultPaths).not.toHaveProperty('timeLogHeading');
    await stopServer(first.child);

    const second = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    admin = await adminOn(second.port);
    expect((await admin('GET', '/api/state')).json.settings.timeLogHeading).toBe('Timelogg');
    await stopServer(second.child);
  }, 40000);

  it('drops unknown keys and ignores non-string values', async () => {
    const { data, md } = dataDir('vault-paths-junk');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(server.port);
    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      settings: {
        ...state.json.settings,
        vaultPaths: { root: '/vault', daily: 42, nonsense: 'go away', timeLogHeading: { no: 'thanks' } },
      },
    });
    expect(put.status).toBe(200);
    const stored = (await admin('GET', '/api/state')).json.settings.vaultPaths;
    // Validated by RECONSTRUCTION: only known string keys survive, everything else takes the
    // default. SB-057 reads these paths to open files; a number or an object reaching it there
    // is a crash in a module that has no business defending against one.
    expect(stored).toEqual({ ...DEFAULTS, root: '/vault' });
    expect(stored).not.toHaveProperty('nonsense');
    await stopServer(server.child);
  }, 40000);

  it('a partial object keeps the defaults for the keys it omits — SB-057/SB-058 extend additively', async () => {
    const { data, md } = dataDir('vault-paths-partial');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(server.port);
    const state = await admin('GET', '/api/state');
    expect(
      (await admin('PUT', '/api/state', { settings: { ...state.json.settings, vaultPaths: { weekly: 'W' } } })).status,
    ).toBe(200);
    expect((await admin('GET', '/api/state')).json.settings.vaultPaths).toEqual({ ...DEFAULTS, weekly: 'W' });
    await stopServer(server.child);
  }, 40000);
});

describe('Settings.vaultTimeSeparator (SB-063, which shipped without a control)', () => {
  it('round-trips each legal value and survives a restart', async () => {
    const { data, md } = dataDir('vault-sep');
    const first = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(first.port);
    expect((await admin('GET', '/api/state')).json.settings.vaultTimeSeparator).toBe('unicode');

    for (const value of ['ascii', 'hyphen', 'unicode']) {
      const state = await admin('GET', '/api/state');
      expect(
        (await admin('PUT', '/api/state', { settings: { ...state.json.settings, vaultTimeSeparator: value } })).status,
      ).toBe(200);
      expect((await admin('GET', '/api/state')).json.settings.vaultTimeSeparator).toBe(value);
    }

    const state = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', { settings: { ...state.json.settings, vaultTimeSeparator: 'ascii' } });
    await stopServer(first.child);

    const second = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    admin = await adminOn(second.port);
    expect((await admin('GET', '/api/state')).json.settings.vaultTimeSeparator).toBe('ascii');
    await stopServer(second.child);
  }, 40000);

  it('an invalid separator never reaches the store', async () => {
    const { data, md } = dataDir('vault-sep-junk');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(server.port);
    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      settings: { ...state.json.settings, vaultTimeSeparator: 'squiggle' },
    });
    expect(put.status).toBe(200); // whitelisted, not rejected — the shipped enum discipline
    expect((await admin('GET', '/api/state')).json.settings.vaultTimeSeparator).toBe('unicode');
    await stopServer(server.child);
  }, 40000);
});
