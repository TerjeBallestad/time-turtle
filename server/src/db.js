// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import TT from '../../shared/core.js';
import { hashPassword } from './auth.js';
import { DB_PATH, ADMIN_EMAIL, ADMIN_PASSWORD, SEED_DEMO } from './config.js';

/** @typedef {import('../../shared/types.ts').Settings} Settings */
/** @typedef {import('../../shared/types.ts').Client} Client */
/** @typedef {import('../../shared/types.ts').Project} Project */
/** @typedef {import('../../shared/types.ts').Task} Task */
/** @typedef {import('../../shared/types.ts').Entry} Entry */
/** @typedef {import('../../shared/types.ts').User} User */
/** @typedef {import('../../shared/types.ts').Role} Role */
/** @typedef {import('../../shared/types.ts').UserCreateRequest} UserCreateRequest */
/** @typedef {import('../../shared/types.ts').StateVersion} StateVersion */

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','employee')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  rounding TEXT NOT NULL DEFAULT 'exact', rate REAL
);
CREATE TABLE IF NOT EXISTS projects (
  code TEXT PRIMARY KEY, name TEXT NOT NULL,
  client_id TEXT, rate REAL
);
CREATE TABLE IF NOT EXISTS tasks (
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  project_code TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, start INTEGER, end INTEGER, dur_min INTEGER,
  project TEXT, label TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', billable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, date);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (scope TEXT PRIMARY KEY, version INTEGER NOT NULL);
-- SDD-002 ruling 4: a per-user commit ledger. One JSON blob per user carrying the
-- CommitSegment[] (each segment's key, server committedAt, and per-entry money
-- snapshot). CREATE TABLE IF NOT EXISTS needs no backfill — fresh + on-disk DBs both
-- get it, and a user with no commits simply has no row (getCommits → []). Rides the
-- per-user 'entries' version scope, so a commit write follows the same DC-001 semantics.
CREATE TABLE IF NOT EXISTS commits (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '[]'
);
`);

// ---- migrations ----
// CREATE TABLE IF NOT EXISTS never touches a table that already exists, so every
// column added after v1 needs a guarded ALTER for databases already on disk.
/** @param {string} table @param {string} column @param {string} definition */
function addColumnIfMissing(table, column, definition) {
  const columns = /** @type {{ name: string }[]} */ (db.prepare(`PRAGMA table_info(${table})`).all());
  if (!columns.some((row) => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// SB-013: a per-user token version baked into each session token; setUserPassword
// bumps it so tokens issued before a password change stop verifying. Existing users
// start at 0. Cookies already issued carry the old 3-field payload and fail the
// 4-field parse in verifyToken, so everyone re-logs in once after this ships — the
// intended clean slate for a security fix.
addColumnIfMissing('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
// SDD-002 supersedes SB-011's task-level billable: the tasks table is rebuilt below
// (per-user, no billable column), so there is no longer a `tasks.billable` to add.
// SDD-002: entries become self-contained (own their project + label) and tasks
// become per-user templates. Guarded column adds for databases already on disk:
addColumnIfMissing('entries', 'project', 'TEXT');
addColumnIfMissing('entries', 'label', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('projects', 'billable', 'INTEGER NOT NULL DEFAULT 1');
// SDD-002 ruling 6 (SB-025, PLAN-007): the 'edited by admin' marker — set when an admin
// corrected this line through the cross-user review edit path. Defaults 0 (untouched).
addColumnIfMissing('entries', 'edited_by_admin', 'INTEGER NOT NULL DEFAULT 0');
// SDD-002 ruling 7 (PLAN-006): archive-not-delete. An archived client/project is hidden
// from creation pickers but keeps resolving for history. Defaults 0 (active) so existing
// on-disk rows stay active and the markdown mirror stays byte-identical.
addColumnIfMissing('clients', 'archived', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('projects', 'archived', 'INTEGER NOT NULL DEFAULT 0');

// One-shot v1→v2 data migration (idempotent — guarded by a schema version marker).
// For every entry: resolve its old task_id against the (old, shared) tasks table and
// COPY the task's name→label + project onto the entry; a dangling id becomes the
// label with a null project (the old silent loss made visible, never permanent). This
// entry copy — dangling rule included — matches parseMd's v1 path in shared/core.js.
// Then rebuild `tasks` as PER-USER templates, seeded from the distinct tasks each
// user's own entries referenced (SDD-002's rule for fanning the old shared table out
// per user). This intentionally DIFFERS from the markdown path, which is already
// per-user and keeps every `## tasks` row: here a globally-unreferenced legacy task
// has no per-user owner and is dropped. Existing entry.billable values are untouched;
// projects default to billable.
// Legacy on-disk DBs keep their now-unused `task_id` column (read only here, then
// vestigial); fresh DBs never get one — the v2 `entries` DDL above omits it.
const TASKS_DDL =
  'CREATE TABLE tasks (user_id INTEGER NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, project_code TEXT, PRIMARY KEY (user_id, id))';
function migrateToSdd002() {
  if (getVersion('schema:sdd002') >= 1) return; // already migrated
  const taskCols = /** @type {{ name: string }[]} */ (db.prepare('PRAGMA table_info(tasks)').all());
  const tasksAreLegacy = taskCols.some((c) => c.name === 'name') && !taskCols.some((c) => c.name === 'user_id');
  transaction(() => {
    if (tasksAreLegacy) {
      const legacy = new Map(
        /** @type {{ id: string, name: string, project_code: string | null }[]} */ (
          db.prepare('SELECT id, name, project_code FROM tasks').all()
        ).map((task) => [task.id, task]),
      );
      // 1. copy label + project onto every entry
      const entries = /** @type {{ id: string, task_id: string | null }[]} */ (
        db.prepare('SELECT id, task_id FROM entries').all()
      );
      const upd = db.prepare('UPDATE entries SET label = ?, project = ? WHERE id = ?');
      for (const entry of entries) {
        const task = entry.task_id != null ? legacy.get(entry.task_id) : null;
        if (task) upd.run(task.name, task.project_code, entry.id);
        else if (entry.task_id != null)
          upd.run(entry.task_id, null, entry.id); // dangling id → raw id as label
        else upd.run('', null, entry.id); // taskless entry
      }
      // 2. rebuild tasks as per-user templates seeded from each user's referenced tasks
      const seed = /** @type {{ user_id: number, task_id: string }[]} */ (
        db.prepare('SELECT DISTINCT user_id, task_id FROM entries WHERE task_id IS NOT NULL').all()
      );
      db.exec('ALTER TABLE tasks RENAME TO tasks_legacy');
      db.exec(TASKS_DDL);
      const ins = db.prepare('INSERT OR IGNORE INTO tasks (user_id, id, label, project_code) VALUES (?, ?, ?, ?)');
      for (const row of seed) {
        const task = legacy.get(row.task_id);
        if (task) ins.run(row.user_id, task.id, task.name, task.project_code);
        else ins.run(row.user_id, row.task_id, row.task_id, null); // dangling referenced id → a stamp of the raw id
      }
      db.exec('DROP TABLE tasks_legacy');
    }
    // projects.billable already defaults to 1 (all billable) — nothing to backfill.
    bumpVersion('schema:sdd002'); // 0 → 1: marks the one-shot migration done
  });
}
migrateToSdd002();

// ---- settings ----
// SB-063: `vaultTimeSeparator` is stored like any other key, and defaults to `unicode` on
// read so an untouched install emits exactly what TT emitted before the setting existed. It
// reaches no mirror byte — TT.serializeMd writes only `currency:`/`language:`/`format:`, the
// same reason `mdDir` has always been invisible there.
//
// SB-056: `backend` is stored the same way and defaults to `sqlite` on read, so an untouched
// install behaves exactly as it did before the setting existed. INSTANCE-LOCAL: it, `mdDir`
// and `vaultPaths` stay in these SQLite rows under BOTH backends and must never be serialized
// into the catalog note (SB-058) — they are how TT finds the catalog, so putting them there
// would be a bootstrap loop. Like `mdDir` it reaches no mirror byte.
//
// SB-056: `vaultPaths` is the one settings key that is not a scalar. It rides the same
// key/value table as ONE JSON value rather than five keys, because it is one decision — where
// the vault is — and reading it back as a partial (root set, daily missing) would be a shape
// no caller wants to handle. Defaulted on read, validated on write; SB-057/SB-058 may extend
// the shape additively, and an older row missing a newer key simply takes that key's default.
// The defaults live in shared/core.js, next to TT.BACKENDS and TT.TIME_SEPARATOR_VALUES — this
// is model vocabulary, and SB-057/SB-058 will extend the shape, so a second copy here would
// quietly start producing a VaultPaths missing their new key.
const VAULT_PATHS_DEFAULT = TT.VAULT_PATHS_DEFAULT;
/** @param {string} raw @returns {import('../../shared/types.ts').VaultPaths} */
function parseVaultPaths(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...VAULT_PATHS_DEFAULT };
    const out = { ...VAULT_PATHS_DEFAULT };
    for (const key of /** @type {(keyof typeof VAULT_PATHS_DEFAULT)[]} */ (Object.keys(VAULT_PATHS_DEFAULT)))
      if (typeof parsed[key] === 'string') out[key] = parsed[key];
    return out;
  } catch {
    return { ...VAULT_PATHS_DEFAULT };
  }
}

/** @returns {Settings & { mdDir: string }} */
export function getSettings() {
  const rows = /** @type {{ key: string, value: string }[]} */ (db.prepare('SELECT key, value FROM settings').all());
  const settings = {
    currency: 'kr',
    language: 'en',
    mdDir: '',
    vaultTimeSeparator: 'unicode',
    backend: 'sqlite',
    vaultPaths: { ...VAULT_PATHS_DEFAULT },
  };
  for (const row of rows) {
    if (row.key === 'vaultPaths') settings.vaultPaths = parseVaultPaths(row.value);
    else settings[/** @type {'currency'|'language'|'mdDir'|'vaultTimeSeparator'|'backend'} */ (row.key)] = row.value;
  }
  return /** @type {Settings & { mdDir: string }} */ (/** @type {unknown} */ (settings));
}
/**
 * SB-056: the backend AS STORED — the raw row, or null when nothing has been stored.
 *
 * `getSettings().backend` cannot answer this. It defaults to `sqlite`, which is also a real
 * choice, so "the setting says sqlite" and "there is no setting" are indistinguishable there —
 * and telling them apart is the whole of `backendTarget()`'s job, since TT_BACKEND is supposed
 * to win exactly when nothing is stored. (`mdDir` has no such problem: its default is `''`, a
 * value nobody can mean, which is why `mirrorTarget()` gets away with reading the defaulted
 * object.) An unrecognised row reads as null, so a hand-edited value falls through to the env
 * rather than being trusted.
 * @returns {import('../../shared/types.ts').Backend | null}
 */
export function getStoredBackend() {
  const row = /** @type {{ value: string } | undefined} */ (
    db.prepare('SELECT value FROM settings WHERE key = ?').get('backend')
  );
  if (!row || !TT.BACKENDS.includes(/** @type {any} */ (row.value))) return null;
  return /** @type {any} */ (row.value);
}
/** @param {Settings} settings */
export function putSettings(settings) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const key of /** @type {const} */ (['currency', 'language', 'mdDir']))
    if (settings[key] != null) upsert.run(key, String(settings[key]));
  // An enum, not free text like currency: an unrecognised value would read back as junk even
  // though TT.timeSeparator would safely emit `→` for it. The vocabulary lives in core.js.
  if (settings.vaultTimeSeparator != null && TT.TIME_SEPARATOR_VALUES.includes(settings.vaultTimeSeparator))
    upsert.run('vaultTimeSeparator', settings.vaultTimeSeparator);
  // SB-056: same enum discipline. An unrecognised backend name must never reach the table —
  // TT.backendCapabilities would resolve it to the safe sqlite row and the operator would be
  // looking at a stored `valut` believing the vault was live. The vocabulary lives in core.js.
  if (settings.backend != null && TT.BACKENDS.includes(settings.backend)) upsert.run('backend', settings.backend);
  // SB-056: `vaultPaths` is validated by RECONSTRUCTION rather than by inspection — the stored
  // value is built key by key from the default, taking only known keys whose value is a string.
  // An unknown key is dropped and a non-string is ignored, so nothing a caller invents can end
  // up in the row and nothing SB-057 later reads can be a non-string. Absent keys keep their
  // defaults, which is what makes SB-057/SB-058's additive extension free.
  if (settings.vaultPaths != null && typeof settings.vaultPaths === 'object' && !Array.isArray(settings.vaultPaths)) {
    const incoming = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (settings.vaultPaths));
    const next = { ...VAULT_PATHS_DEFAULT };
    for (const key of /** @type {(keyof typeof VAULT_PATHS_DEFAULT)[]} */ (Object.keys(VAULT_PATHS_DEFAULT)))
      if (typeof incoming[key] === 'string') next[key] = /** @type {string} */ (incoming[key]);
    upsert.run('vaultPaths', JSON.stringify(next));
  }
}

// ---- catalog ----
/** @returns {Client[]} */
export function getClients() {
  const rows = /** @type {{ id: string, name: string, rounding: string, rate: number | null, archived: number }[]} */ (
    db.prepare('SELECT id, name, rounding, rate, archived FROM clients').all()
  );
  return rows.map((client) => ({
    ...client,
    rounding: client.rounding === 'exact' ? 'exact' : +client.rounding,
    archived: !!client.archived,
  }));
}
/** @returns {Project[]} */
export function getProjects() {
  const rows = /** @type {(Omit<Project, 'billable' | 'archived'> & { billable: number, archived: number })[]} */ (
    /** @type {unknown} */ (
      db.prepare('SELECT code, name, client_id AS clientId, rate, billable, archived FROM projects').all()
    )
  );
  return rows.map((project) => ({ ...project, billable: !!project.billable, archived: !!project.archived }));
}
/** SDD-002: templates are per-user. @param {number} userId @returns {Task[]} */
export function getTasks(userId) {
  return /** @type {Task[]} */ (
    /** @type {unknown} */ (
      db.prepare('SELECT id, label, project_code AS project FROM tasks WHERE user_id = ? ORDER BY id').all(userId)
    )
  );
}
/**
 * @template T
 * @param {string} table @param {T[]} rows @param {(row: T) => void} insert
 */
function replaceAll(table, rows, insert) {
  db.exec(`DELETE FROM ${table}`);
  for (const row of rows) insert(row);
}
/**
 * SB-072: `name` is trimmed here, not at the API boundary. The mirror parser splits a row on
 * `|` and trims every cell (`splitCells` → `splitUnescaped(s, '|', true)`, shared/core.js), so
 * it cannot tell format padding from typed content and a stored `'  Acme  '` comes back
 * `'Acme'`. Terje's re-ruling: make the data fit the format rather than escape the edges —
 * normalize on the way in so the DB never holds a value the mirror cannot round-trip. It lives
 * at this layer, on the `String(name).trim()` precedent in createUser below, because a
 * client-side trim is bypassable by any direct PUT and so cannot support a data-integrity
 * claim. Same `.trim()` the parser uses, so the two agree exactly; interior whitespace, which
 * the format DOES carry, is untouched.
 * @param {Client[]} clients */
export function putClients(clients) {
  const insert = db.prepare('INSERT INTO clients (id, name, rounding, rate, archived) VALUES (?, ?, ?, ?, ?)');
  replaceAll('clients', clients, (client) =>
    insert.run(
      String(client.id),
      String(client.name).trim(),
      String(client.rounding ?? 'exact'),
      client.rate == null ? null : +client.rate,
      client.archived ? 1 : 0,
    ),
  );
}
/** @param {Project[]} projects */
export function putProjects(projects) {
  const insert = db.prepare(
    'INSERT INTO projects (code, name, client_id, rate, billable, archived) VALUES (?, ?, ?, ?, ?, ?)',
  );
  replaceAll('projects', projects, (project) =>
    insert.run(
      String(project.code),
      String(project.name),
      project.clientId == null ? null : String(project.clientId),
      project.rate == null ? null : +project.rate,
      project.billable === false ? 0 : 1,
      project.archived ? 1 : 0,
    ),
  );
}
// SDD-002 ruling 7 (PLAN-006): the never-referenced true-delete guard. Archive is the
// default; a HARD delete (a code/id dropped from the collection-replace PUT) is allowed
// only when nothing references it. These cross-cutting checks are the enforcement — a
// client-side guard is cosmetic under collection-replace.
/** Does ANY user's entry carry this project code? @param {string} code @returns {boolean} */
export function projectCodeReferenced(code) {
  const row = /** @type {{ n: number }} */ (
    db.prepare('SELECT COUNT(*) AS n FROM entries WHERE project = ?').get(String(code))
  );
  return row.n > 0;
}
/** Does ANY project belong to this client? @param {string} id @returns {boolean} */
export function clientReferenced(id) {
  const row = /** @type {{ n: number }} */ (
    db.prepare('SELECT COUNT(*) AS n FROM projects WHERE client_id = ?').get(String(id))
  );
  return row.n > 0;
}

// SDD-002 DC-005 (PLAN-006): the server-reconciled project-code rename. A code rename used
// to rewrite only the acting admin's own copy-at-birth data, orphaning every OTHER user's
// entries + templates under the old code. This rewrites the projects row AND every user's
// entries.project AND every user's tasks.project_code from old→new in ONE transaction, so
// nothing dangles. A BLIND reconcile — it touches only the code, never reads entry content —
// so SB-009's per-user privacy line stays intact. Returns the affected user ids (those whose
// entries or templates moved) so the caller can rewrite their mirrors. Bumps the catalog
// version and every affected user's entries version.
/** @param {string} oldCode @param {string} newCode @returns {number[]} */
export function renameProjectCode(oldCode, newCode) {
  return transaction(() => {
    const affected = new Set(
      /** @type {{ id: number }[]} */ ([
        ...db.prepare('SELECT DISTINCT user_id AS id FROM entries WHERE project = ?').all(String(oldCode)),
        ...db.prepare('SELECT DISTINCT user_id AS id FROM tasks WHERE project_code = ?').all(String(oldCode)),
      ]).map((row) => row.id),
    );
    db.prepare('UPDATE projects SET code = ? WHERE code = ?').run(String(newCode), String(oldCode));
    db.prepare('UPDATE entries SET project = ? WHERE project = ?').run(String(newCode), String(oldCode));
    db.prepare('UPDATE tasks SET project_code = ? WHERE project_code = ?').run(String(newCode), String(oldCode));
    bumpVersion('catalog');
    for (const id of affected) bumpVersion(entriesScope(id));
    return [...affected];
  });
}

// SB-087 (SB-067 fix 3): the server-reconciled CLIENT-ID rename — the small twin of
// renameProjectCode above. `projects.client_id` is the ONLY persisted reference to a client
// id anywhere in the model: entries and templates carry project CODES, and a commit snapshot
// is keyed by entry id and stores only {rate, billMin, amount}. So re-pointing that one
// column IS the whole reconcile — no user's entries move, and no per-user entries version
// needs bumping (only the catalog changed).
//
// It has to be ONE transaction because the two halves are refused separately: dropping the
// old client id while projects still point at it is exactly the referenced delete that
// `guardReferencedDeletes` (server/src/index.js) rejects with a 409. The guard reads the
// STORED rows before the write, so no single collection-replace PUT can ever satisfy it.
//
// Returns how many project rows were re-pointed.
/** @param {string} oldId @param {string} newId @returns {number} */
export function renameClientId(oldId, newId) {
  return transaction(() => {
    db.prepare('UPDATE clients SET id = ? WHERE id = ?').run(String(newId), String(oldId));
    const moved = db.prepare('UPDATE projects SET client_id = ? WHERE client_id = ?').run(String(newId), String(oldId));
    bumpVersion('catalog');
    return Number(moved.changes);
  });
}

/** SDD-002: replace one user's templates only — never the whole table.
 * @param {number} userId @param {Task[]} tasks */
export function putTasks(userId, tasks) {
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO tasks (user_id, id, label, project_code) VALUES (?, ?, ?, ?)');
  for (const task of tasks) {
    insert.run(userId, String(task.id), String(task.label), task.project == null ? null : String(task.project));
  }
}

// ---- entries (per user) ----
// SB-059: `tags` joins `billable`/`editedByAdmin` in the Omit. Not a workaround — the SELECT
// below really does not return it: there is no tags column, because the vault block is that
// field's only serialization today. Naming it here is what keeps the cast a true statement
// about this query, and is why the compiler will flag the day a tags column lands and this
// Omit is left behind.
/** @param {number} userId @returns {Entry[]} */
export function getEntries(userId) {
  const rows =
    /** @type {(Omit<Entry, 'billable' | 'editedByAdmin' | 'tags'> & { billable: number, editedByAdmin: number })[]} */ (
      db
        .prepare(
          'SELECT id, date, start, end, dur_min AS durMin, project, label, note, billable, edited_by_admin AS editedByAdmin FROM entries WHERE user_id = ? ORDER BY date, id',
        )
        .all(userId)
    );
  // editedByAdmin is emit-when-true everywhere (serializer + type), so surface it only
  // when set — an untouched entry has no field, matching parseMd's shape.
  return rows.map(({ editedByAdmin, ...entry }) => {
    /** @type {Entry} */
    const mapped = { ...entry, billable: !!entry.billable };
    if (editedByAdmin) mapped.editedByAdmin = true;
    return mapped;
  });
}
/**
 * Every user's entries over an inclusive date range — the raw input to the admin
 * team report. Server-side only: these rows are aggregated before they leave.
 * @param {string} [from] @param {string} [to] @returns {(Entry & { userId: number })[]}
 */
export function getAllEntries(from, to) {
  const where = [];
  const params = [];
  if (from) {
    where.push('date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('date <= ?');
    params.push(to);
  }
  const sql =
    'SELECT id, user_id AS userId, date, start, end, dur_min AS durMin, project, label, note, billable FROM entries' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY user_id, date, id';
  const rows =
    /** @type {(Omit<Entry & { userId: number }, 'billable' | 'editedByAdmin' | 'tags'> & { billable: number })[]} */ (
      db.prepare(sql).all(...params)
    );
  return rows.map((entry) => ({ ...entry, billable: !!entry.billable }));
}
// SB-070: entry ids are charset-validated at the API boundary (`entryIdError`, server/src/
// index.js) because they reach the mirror's unescaped `## commits` section. This layer stays
// a dumb writer — String(entry.id) — so any NEW write path must run that guard itself.
//
// SB-072: `note` is the exception — it is NORMALIZED here rather than rejected, because the
// mirror parser trims every cell it splits out and so silently eats a note's leading/trailing
// whitespace on a restore. Trimming on the way in keeps the DB inside what the format can
// represent; see the putClients comment for the full ruling. Normalization sits at this layer
// (all write paths, including the admin cross-user one and the demo seed) while rejection sits
// at the API boundary, where it can return an error. Interior whitespace is untouched.
/** @param {number} userId @param {Entry[]} entries */
export function putEntries(userId, entries) {
  db.prepare('DELETE FROM entries WHERE user_id = ?').run(userId);
  const insert = db.prepare(
    'INSERT INTO entries (id, user_id, date, start, end, dur_min, project, label, note, billable, edited_by_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date))) continue;
    insert.run(
      String(entry.id),
      userId,
      String(entry.date),
      entry.start == null ? null : +entry.start,
      entry.end == null ? null : +entry.end,
      entry.durMin == null ? null : +entry.durMin,
      entry.project == null ? null : String(entry.project),
      String(entry.label ?? ''),
      String(entry.note ?? '').trim(),
      entry.billable ? 1 : 0,
      entry.editedByAdmin ? 1 : 0,
    );
  }
}

// ---- commits (per user) ----
// SDD-002 ruling 4: the CommitSegment[] ledger, stored as one JSON blob per user.
// The snapshot is a nested per-entry map, so JSON is the natural shape (the plan
// pre-authorized a JSON column over a relational one). getCommits defaults to [].
/** @typedef {import('../../shared/types.ts').CommitSegment} CommitSegment */
/** @param {number} userId @returns {CommitSegment[]} */
export function getCommits(userId) {
  const row = /** @type {{ data: string } | undefined} */ (
    db.prepare('SELECT data FROM commits WHERE user_id = ?').get(userId)
  );
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
/** @param {number} userId @param {CommitSegment[]} commits */
export function putCommits(userId, commits) {
  db.prepare(
    'INSERT INTO commits (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data',
  ).run(userId, JSON.stringify(Array.isArray(commits) ? commits : []));
}

// ---- versions (DC-001: optimistic concurrency) ----
// Two scopes: 'catalog' for the shared collections, 'entries:<userId>' for one
// user's own entries. A missing row reads as 0, so an existing database starts
// at 0 without a migration.
/** @param {number} userId @returns {string} */
const entriesScope = (userId) => 'entries:' + userId;
/** @param {string} scope @returns {number} */
function getVersion(scope) {
  const row = /** @type {{ version: number } | undefined} */ (
    db.prepare('SELECT version FROM versions WHERE scope = ?').get(scope)
  );
  return row ? row.version : 0;
}
/** @param {number} userId @returns {StateVersion} */
export function getVersions(userId) {
  return { catalog: getVersion('catalog'), entries: getVersion(entriesScope(userId)) };
}
/** @param {string} scope */
function bumpVersion(scope) {
  db.prepare(
    'INSERT INTO versions (scope, version) VALUES (?, 1) ON CONFLICT(scope) DO UPDATE SET version = version + 1',
  ).run(scope);
}
export function bumpCatalogVersion() {
  bumpVersion('catalog');
}
/** @param {number} userId */
export function bumpEntriesVersion(userId) {
  bumpVersion(entriesScope(userId));
}

// ---- users ----
/** @param {string} email @returns {(User & { password_hash: string, token_version: number }) | null} */
export function findUserByEmail(email) {
  return /** @type {(User & { password_hash: string, token_version: number }) | null} */ (
    db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase()) ?? null
  );
}
/** @param {number | bigint} id @returns {User | null} */
export function findUserById(id) {
  return /** @type {User | null} */ (
    db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(id) ?? null
  );
}
/** Like findUserById but carries the hash — only for verifying a self-service password change.
 * @param {number} id @returns {(User & { password_hash: string }) | null} */
export function findUserWithHash(id) {
  return /** @type {(User & { password_hash: string }) | null} */ (
    db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null
  );
}
/** @returns {User[]} */
export function listUsers() {
  return /** @type {User[]} */ (
    /** @type {unknown} */ (
      db.prepare('SELECT id, email, name, role, created_at AS createdAt FROM users ORDER BY id').all()
    )
  );
}
/** @param {UserCreateRequest} user @returns {User | null} */
export function createUser({ email, name, role, password }) {
  const result = db
    .prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run(
      String(email).trim().toLowerCase(),
      String(name).trim(),
      role === 'admin' ? 'admin' : 'employee',
      hashPassword(password),
    );
  return findUserById(result.lastInsertRowid);
}
/** @param {number} id @param {string} password */
export function setUserPassword(id, password) {
  // SB-013: bump token_version in the same write so every session token minted before
  // this change fails verification — a password change logs the other sessions out.
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
    hashPassword(password),
    id,
  );
}
/** The signed-token version to compare a session against. SB-013.
 * @param {number} id @returns {number | null} */
export function getTokenVersion(id) {
  const row = /** @type {{ token_version: number } | undefined} */ (
    db.prepare('SELECT token_version FROM users WHERE id = ?').get(id)
  );
  return row ? row.token_version : null;
}
/** @param {number} id */
export function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

/**
 * @template T
 * @param {() => T} fn @returns {T}
 */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- first-run seed ----
export function seedIfEmpty() {
  const userCount = /** @type {{ n: number }} */ (db.prepare('SELECT COUNT(*) AS n FROM users').get());
  if (userCount.n === 0) {
    const admin = createUser({ email: ADMIN_EMAIL, name: 'Admin', role: 'admin', password: ADMIN_PASSWORD });
    if (!admin) throw new Error('failed to create the admin user');
    console.log(
      `[time-turtle] created admin user ${admin.email} (password from TT_ADMIN_PASSWORD${process.env.TT_ADMIN_PASSWORD ? '' : ", default 'turtle' — change it"})`,
    );
    const projectCount = /** @type {{ n: number }} */ (db.prepare('SELECT COUNT(*) AS n FROM projects').get());
    if (SEED_DEMO && projectCount.n === 0) {
      const seedState = TT.seed();
      transaction(() => {
        putSettings(seedState.settings);
        putClients(seedState.clients);
        putProjects(seedState.projects);
        putTasks(admin.id, seedState.tasks);
        putEntries(admin.id, seedState.entries);
      });
      console.log('[time-turtle] seeded demo data (disable with TT_SEED_DEMO=0)');
    }
  }
}
