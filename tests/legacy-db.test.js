// SB-181 — a data dir from obsidian-final still opens.
//
// The shape concept, the vault backend and the markdown mirror are gone, and nothing migrates
// their data away. An existing database keeps its `shape`, `mdDir`, `vaultPaths`,
// `vaultTimeSeparator` and `vaultCutover` settings rows, its `vault_index` table and its
// `users.mirror_slug` column. The server stops reading and writing them — `firstRunAnswered` reads
// the `shape` row for its presence and nothing else.
//
// THE DATA DIRS ARE BUILT WITH RAW SQL, in the shape obsidian-final writes them: its DDL, its
// migrated columns, its settings rows. This is an imitation, and the task note carries the other
// half of the evidence — a data dir the real obsidian-final server wrote, booted on this code.
//
// Two variants:
//   (a) a personal install: one admin with the published password, `shape=personal`, a vault
//       cutover, vault paths, a time separator, a mirror dir, a `vault_index` row, and entries on
//       both sides of the cutover.
//   (b) a team install: two users, `shape=team`, a mirror dir, and a committed segment.
//
// ## Verified red-green: 2026-09-17, TRANSCRIBED.
//   (1) `firstRunAnswered` made to ignore the legacy `shape` row (`key IN ('firstRunAt')`) — 1 of 2:
//       ×  (a) a personal install boots, keeps its rows, and its admin edits every entry
//          AssertionError: an install that answered the shape question is asked again:
//          expected true to be false // Object.is equality
//   (2) `putSettings` made to write every incoming key — 2 of 2:
//       ×  (a) …  AssertionError: the legacy settings rows moved: expected [ …(7) ] to deeply equal [ …(7) ]
//       ×  (b) …  AssertionError: the legacy settings rows moved: expected [ …(7) ] to deeply equal [ …(4) ]
import { describe, it, expect, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, session } from './util.js';

afterAll(stopAllServers);

/** The same `salt:hash` scrypt format server/src/auth.js writes. */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 32).toString('hex');
}

/** obsidian-final's schema, with every column its migrations add, as one DDL. */
const OBSIDIAN_FINAL_DDL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','employee')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  token_version INTEGER NOT NULL DEFAULT 0,
  mirror_slug TEXT NOT NULL DEFAULT ''
);
CREATE TABLE clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  rounding TEXT NOT NULL DEFAULT 'exact', rate REAL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE projects (
  code TEXT PRIMARY KEY, name TEXT NOT NULL,
  client_id TEXT, rate REAL,
  billable INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE tasks (user_id INTEGER NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, project_code TEXT, PRIMARY KEY (user_id, id));
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, start INTEGER, end INTEGER, dur_min INTEGER,
  project TEXT, label TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', billable INTEGER NOT NULL DEFAULT 1,
  edited_by_admin INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_entries_user_date ON entries(user_id, date);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE versions (scope TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE commits (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE vault_index (
  path TEXT PRIMARY KEY, date TEXT NOT NULL, state TEXT NOT NULL, rev INTEGER, payload_digest TEXT,
  prev_rev INTEGER, prev_payload_digest TEXT, file_sha TEXT, verified INTEGER, quarantine_reason TEXT,
  seen_at TEXT, written_at TEXT, quarantined_at TEXT
);
INSERT INTO versions (scope, version) VALUES ('schema:sdd002', 1);
`;

const CUTOVER = '2026-07-15T09:12:33.000Z';
const PRE = '2026-07-01'; // before the cutover — frozen under obsidian-final's personal shape
const POST = '2026-07-20'; // after it
const TEAM_DAY = '2026-07-22';

const entryRow = (db, id, userId, date, label) =>
  db
    .prepare(
      "INSERT INTO entries (id, user_id, date, start, end, dur_min, project, label, note, billable) VALUES (?, ?, ?, 540, 600, NULL, NULL, ?, '', 1)",
    )
    .run(id, userId, date, label);

const setting = (db, key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);

/** (a) a personal install, as obsidian-final leaves it. */
function personalDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tt-legacy-personal-'));
  const db = new DatabaseSync(join(dir, 'timeturtle.db'));
  db.exec(OBSIDIAN_FINAL_DDL);
  db.prepare(
    "INSERT INTO users (email, name, role, password_hash, mirror_slug) VALUES ('admin@timeturtle.local', 'Admin', 'admin', ?, 'admin')",
  ).run(hashPassword('turtle'));
  setting(db, 'currency', 'kr');
  setting(db, 'language', 'en');
  setting(db, 'shape', 'personal');
  setting(db, 'vaultCutover', CUTOVER);
  setting(
    db,
    'vaultPaths',
    JSON.stringify({
      root: '/Users/someone/vault',
      daily: 'Calendar/Daily',
      weekly: 'Calendar/Weekly',
      catalog: 'Time Turtle/Catalog.md',
      timeLogHeading: 'Time Log',
    }),
  );
  setting(db, 'vaultTimeSeparator', 'ascii');
  setting(db, 'mdDir', '/Users/someone/vault/Time Turtle/mirror');
  db.prepare(
    "INSERT INTO vault_index (path, date, state, rev, payload_digest, file_sha, verified, seen_at, written_at) VALUES (?, ?, 'known', 3, 'a3f1', 'deadbeef', 1, ?, ?)",
  ).run('/Users/someone/vault/Calendar/Daily/' + POST + '.md', POST, CUTOVER, CUTOVER);
  entryRow(db, 'e1-pre', 1, PRE, 'from before the vault');
  entryRow(db, 'e2-post', 1, POST, 'from after the vault');
  db.close();
  return dir;
}

/** (b) a team install, as obsidian-final leaves it. */
function teamDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tt-legacy-team-'));
  const db = new DatabaseSync(join(dir, 'timeturtle.db'));
  db.exec(OBSIDIAN_FINAL_DDL);
  const insertUser = db.prepare(
    'INSERT INTO users (email, name, role, password_hash, mirror_slug) VALUES (?, ?, ?, ?, ?)',
  );
  insertUser.run('admin@timeturtle.local', 'Admin', 'admin', hashPassword('turtle'), 'admin');
  insertUser.run('kari@timeturtle.local', 'Kari Ansatt', 'employee', hashPassword('karipw'), 'kari-ansatt');
  setting(db, 'currency', 'kr');
  setting(db, 'language', 'nb');
  setting(db, 'shape', 'team');
  setting(db, 'mdDir', '/srv/tt/markdown');
  entryRow(db, 'e1-admin', 1, TEAM_DAY, 'admin hour');
  entryRow(db, 'e2-kari', 2, TEAM_DAY, 'committed hour');
  db.prepare('INSERT INTO commits (user_id, data) VALUES (2, ?)').run(
    JSON.stringify([
      {
        key: TT.segmentKey(TEAM_DAY),
        committedAt: '2026-07-26T10:00:00.000Z',
        snapshot: { 'e2-kari': { rate: 0, billMin: 60, amount: 0 } },
      },
    ]),
  );
  db.close();
  return dir;
}

/** Every settings row, in key order, exactly as stored. */
function settingsRows(dir) {
  const db = new DatabaseSync(join(dir, 'timeturtle.db'), { readOnly: true });
  try {
    return db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  } finally {
    db.close();
  }
}

/** A bare loopback fetch with no credential — the first run takes none. */
const firstRun = async (port) => (await fetch(`http://127.0.0.1:${port}/api/first-run`)).json();

/**
 * Boot the data dir, log in as the admin, and run the checks every variant shares. Returns the
 * admin session and the running server so a variant can add its own.
 */
async function bootAndCheck(dir, expectedEntryIds) {
  const before = settingsRows(dir);
  // `TT_ADMIN_PASSWORD: ''` so nothing but the stored hash decides the login.
  const server = await startServer({ TT_DATA_DIR: dir, TT_SEED_DEMO: '0', TT_ADMIN_PASSWORD: '' });

  const admin = session(server.port);
  const login = await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'turtle' });
  expect(login.status, 'the admin cannot log in to an obsidian-final data dir').toBe(200);

  const state = await admin('GET', '/api/state');
  expect(state.status).toBe(200);
  expect(state.json.settings).toEqual({
    currency: before.find((r) => r.key === 'currency').value,
    language: before.find((r) => r.key === 'language').value,
  });

  // A stale tab PUTs the whole settings object, removed keys included. 200, and ignored.
  const put = await admin('PUT', '/api/state', {
    settings: {
      ...state.json.settings,
      shape: 'team',
      mdDir: '/somewhere/else',
      vaultCutover: '',
      vaultPaths: { root: '/elsewhere' },
      vaultTimeSeparator: 'hyphen',
    },
    version: state.json.version,
  });
  expect(put.status).toBe(200);
  expect(settingsRows(dir), 'the legacy settings rows moved').toEqual(before);

  return { server, admin, state: state.json, expectedEntryIds };
}

describe('SB-181: a data dir from obsidian-final still opens', () => {
  it('(a) a personal install boots, keeps its rows, and its admin edits every entry', async () => {
    const dir = personalDataDir();
    const { server, admin, state } = await bootAndCheck(dir);

    // Every stored entry comes back, on both sides of the old cutover.
    expect(state.entries.map((e) => e.id).sort()).toEqual(['e1-pre', 'e2-post']);

    // The pre-cutover day was frozen under obsidian-final. It is an ordinary day now.
    const fresh = await admin('GET', '/api/state');
    const edited = fresh.json.entries.map((e) => (e.id === 'e1-pre' ? { ...e, label: 'edited after upgrade' } : e));
    const save = await admin('PUT', '/api/state', { entries: edited, version: fresh.json.version });
    expect(save.status, JSON.stringify(save.json)).toBe(200);
    const after = await admin('GET', '/api/state');
    expect(after.json.entries.find((e) => e.id === 'e1-pre').label).toBe('edited after upgrade');

    // One user and a legacy `shape` row: answered. The first run is closed.
    const probe = await firstRun(server.port);
    expect(probe.open, 'an install that answered the shape question is asked again').toBe(false);

    // The single-user guard is gone: the admin adds a second user.
    const created = await admin('POST', '/api/users', {
      email: 'second@timeturtle.local',
      name: 'Second',
      role: 'employee',
      password: 'secondpw',
    });
    expect(created.status).toBe(200);

    // The vault_index table and the mirror_slug column are still there, untouched.
    await stopServer(server.child);
    const db = new DatabaseSync(join(dir, 'timeturtle.db'), { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM vault_index').get().n).toBe(1);
    expect(db.prepare("SELECT mirror_slug FROM users WHERE email = 'admin@timeturtle.local'").get().mirror_slug).toBe(
      'admin',
    );
    db.close();
  }, 60000);

  it('(b) a team install boots, keeps its rows, and serves both users’ entries', async () => {
    const dir = teamDataDir();
    const { server, admin, state } = await bootAndCheck(dir);

    expect(state.entries.map((e) => e.id)).toEqual(['e1-admin']);
    const kari = await admin('GET', '/api/users/2/timesheet');
    expect(kari.status).toBe(200);
    expect(kari.json.entries.map((e) => e.id)).toEqual(['e2-kari']);
    expect(kari.json.commits.map((c) => c.key)).toEqual([TT.segmentKey(TEAM_DAY)]);

    const probe = await firstRun(server.port);
    expect(probe.open).toBe(false);

    await stopServer(server.child);
  }, 60000);
});
