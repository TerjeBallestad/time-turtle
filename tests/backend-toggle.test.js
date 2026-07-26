// SB-056: the storage backend toggle — `Settings.backend`, `TT_BACKEND`, `TT_BACKEND_LOCK`.
//
// DC-002 isomorphic to the mirror lock, so this file is md-dir-lock.test.js's shape on
// purpose: SEVERAL REAL SERVERS, so "the backend is what changed it" is proven by CONTRAST
// rather than asserted about one server. A single server reporting `backend: 'vault'` proves
// only that a flag was reported.
//
// The load-bearing assertion is the ABSENT MIRROR FILE after a save that really landed
// (DD-011: the v2 `|`-mirror stops under `vault`). Every such test therefore also asserts the
// DATABASE took the write — otherwise a PUT failing for an unrelated reason would leave no
// mirror file either, and pass this suite while proving nothing.
//
// ## Verified red-green: 2026-07-26
//   Forcing `activeBackend()` (server/src/backend.js) to `return 'sqlite'` unconditionally:
//     FAIL  the vault server writes NO mirror file, while the sqlite server writes one
//           AssertionError: expected [ 'timesheet-admin.md' ] to deeply equal []
//     FAIL  a stored backend setting beats TT_BACKEND, and survives a restart
//           AssertionError: expected 'sqlite' to be 'vault'
//     FAIL  TT_BACKEND_LOCK beats a stored `vault` setting — the documented recovery
//           AssertionError: expected [] to have a length above 0
//   i.e. the mirror really does keep writing into the folder when the backend is not consulted.
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

const SQLITE = dataDir('backend-sqlite');
const VAULT = dataDir('backend-vault');
const LOCKED = dataDir('backend-locked');

let SQLITE_PORT;
let VAULT_PORT;
let LOCKED_PORT;

beforeAll(async () => {
  const [sqlite, vault, locked] = await Promise.all([
    // the contrast server: the repo default, nothing set
    startServer({ TT_DATA_DIR: SQLITE.data, TT_MD_DIR: SQLITE.md }),
    startServer({ TT_DATA_DIR: VAULT.data, TT_MD_DIR: VAULT.md, TT_BACKEND: 'vault' }),
    startServer({ TT_DATA_DIR: LOCKED.data, TT_MD_DIR: LOCKED.md, TT_BACKEND: 'sqlite', TT_BACKEND_LOCK: '1' }),
  ]);
  SQLITE_PORT = sqlite.port;
  VAULT_PORT = vault.port;
  LOCKED_PORT = locked.port;
}, 30000);

afterAll(stopAllServers);

describe('TT_BACKEND', () => {
  it('the vault server writes NO mirror file, while the sqlite server writes one from the same request', async () => {
    const sqliteAdmin = await adminOn(SQLITE_PORT);
    const vaultAdmin = await adminOn(VAULT_PORT);

    const sqlitePut = await logAnHour(sqliteAdmin, 'e1-sqlite');
    const vaultPut = await logAnHour(vaultAdmin, 'e1-vault');

    // The contrast: the SAME request shape, one backend apart.
    expect(sqlitePut.json.mirror).toBeTruthy();
    expect(mirrorFiles(SQLITE.md)).toEqual(['timesheet-admin.md']);

    expect(vaultPut.json.mirror).toBe(null);
    expect(mirrorFiles(VAULT.md)).toEqual([]);
  });

  it('reports the effective backend on /api/state', async () => {
    const sqliteState = await (await adminOn(SQLITE_PORT))('GET', '/api/state');
    expect(sqliteState.json.backend).toBe('sqlite');
    expect(sqliteState.json.backendLocked).toBe(false);

    const vaultState = await (await adminOn(VAULT_PORT))('GET', '/api/state');
    expect(vaultState.json.backend).toBe('vault');
    expect(vaultState.json.backendLocked).toBe(false);
  });

  it('refuses to start on an unknown TT_BACKEND rather than falling back to sqlite', async () => {
    // A typo that silently means `sqlite` is the worst reading available: the operator
    // believes the vault is live while the mirror keeps writing into it.
    const { code, output } = await runServerUntilExit({
      TT_DATA_DIR: dataDir('backend-typo').data,
      TT_BACKEND: 'valut',
    });
    expect(code).not.toBe(0);
    expect(output).toMatch(/valut/);
    expect(output).toMatch(/sqlite, vault/);
  }, 30000);
});

describe('Settings.backend', () => {
  it('a stored backend setting beats TT_BACKEND, and survives a restart', async () => {
    const { data, md } = dataDir('backend-stored');
    // Started EXPLICITLY on sqlite, so "the setting won" is a contest and not a default.
    const before = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_BACKEND: 'sqlite' });
    const admin = await adminOn(before.port);
    expect((await admin('GET', '/api/state')).json.backend).toBe('sqlite');

    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, backend: 'vault' } });
    expect(put.status).toBe(200);
    // It takes effect immediately — the resolution is read at call time, not cached at boot.
    expect((await admin('GET', '/api/state')).json.backend).toBe('vault');
    await stopServer(before.child);

    const after = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_BACKEND: 'sqlite' });
    const restarted = await adminOn(after.port);
    expect((await restarted('GET', '/api/state')).json.backend).toBe('vault');
    // and the mirror is off for it, still, with TT_BACKEND saying otherwise
    const put2 = await logAnHour(restarted, 'e1-stored');
    expect(put2.json.mirror).toBe(null);
    expect(mirrorFiles(md)).toEqual([]);
  }, 40000);

  it('an unrecognised backend value never reaches the store', async () => {
    const admin = await adminOn(SQLITE_PORT);
    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, backend: 'valut' } });
    // Whitelisted, not rejected — the enum discipline vaultTimeSeparator already uses.
    expect(put.status).toBe(200);
    const after = await admin('GET', '/api/state');
    expect(after.json.settings.backend).toBe('sqlite');
    expect(after.json.backend).toBe('sqlite');
  });
});

describe('TT_BACKEND_LOCK', () => {
  it('rejects a change to the backend with 403, and the setting does not sneak in', async () => {
    const admin = await adminOn(LOCKED_PORT);
    const state = await admin('GET', '/api/state');
    expect(state.json.backendLocked).toBe(true);

    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, backend: 'vault' } });
    expect(put.status).toBe(403);
    expect(put.json.error).toMatch(/TT_BACKEND_LOCK/);

    const after = await admin('GET', '/api/state');
    expect(after.json.settings.backend).toBe('sqlite');
    expect(after.json.backend).toBe('sqlite');
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
    expect(after.json.settings.backend).toBe('sqlite');
  });

  it('beats a `vault` already stored in the database — the documented recovery', async () => {
    // `TT_BACKEND_LOCK=1 TT_BACKEND=sqlite` is the ONLY way out of an install whose stored
    // setting says `vault` and whose user table says otherwise (a copied data dir). It has to
    // beat the stored setting, not merely supply a default — a default LOSES to the setting,
    // and losing to the setting is the wedge.
    const { data, md } = dataDir('backend-recover');
    const before = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(before.port);
    const state = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, backend: 'vault' } })).status).toBe(
      200,
    );
    expect((await admin('GET', '/api/state')).json.backend).toBe('vault');
    await stopServer(before.child);

    const after = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_BACKEND: 'sqlite', TT_BACKEND_LOCK: '1' });
    const recovered = await adminOn(after.port);
    const recoveredState = await recovered('GET', '/api/state');
    expect(recoveredState.json.backend).toBe('sqlite');
    expect(recoveredState.json.backendLocked).toBe(true);
    // The stored value is still `vault` — it is IGNORED, not rewritten. That matters: the
    // recovery must not silently destroy what the operator chose.
    expect(recoveredState.json.settings.backend).toBe('vault');
    // And sqlite is really in force: the mirror writes again.
    const put = await logAnHour(recovered, 'e1-recover');
    expect(put.json.mirror).toBeTruthy();
    expect(mirrorFiles(md).length).toBeGreaterThan(0);
    // A PUT echoing that stored `vault` back is UNCHANGED, so it rides along rather than 403ing
    // — otherwise the recovered install could never save its settings at all.
    const echo = await recovered('PUT', '/api/state', {
      settings: { ...recoveredState.json.settings, currency: 'USD' },
    });
    expect(echo.status).toBe(200);
  }, 40000);
});
