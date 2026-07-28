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
-- SB-057: what TT last read from, and last wrote to, each daily note. One row per PATH.
--
-- WHAT THIS TABLE IS FOR, and — just as important — what it is NOT for.
--
-- It is NOT the corruption detector. DD-009 deliberately took that job away from an index and
-- put it ON THE NOTE (the payload digest in the "revision: N · a3f1" anchor), and the deciding
-- argument was exactly that an on-note digest needs no surviving state: any TT, on any machine,
-- after any crash or index rebuild, verifies a block against itself. "The index must be durable"
-- is an argument that was RETIRED. Do not reinstate it here. This table may be deleted, rebuilt
-- or lost without any block becoming undetectably corrupt.
--
-- It IS required for two things that stand on their own merits:
--   1. the "file rev < index rev" split (design decision 5). Telling "a peer that is simply
--      behind" from "somebody restored this note from git" needs TT's record of what the note
--      looked like at the PREVIOUS revision, and no note carries its own history.
--   2. the own-write echo guard — file_sha is how the watcher recognises TT's own write and
--      declines to re-import it.
--
-- CREATE TABLE IF NOT EXISTS, no migration, and an existing DB starts EMPTY. That is not a gap:
-- an empty index reads as "nothing known yet", which is the correct cold-start state, and under
-- the write scope rule (design decision 2) it licenses no writes at all until a scan has read
-- something.
--
-- state is known | unknown | quarantined, and only known licenses a write. That is what
-- makes invariant 1 ("unreadable or absent → unknown, never empty") mean something on the WRITE
-- side rather than being a comment on the read side.
--
-- TWO HASHES, TWO JOBS (design decision 3), and they must never be collapsed into one:
--   file_sha       — sha256 over the WHOLE FILE (node:crypto, server-side). Answers "did this
--                      file change at all", which is the cheap skip that makes the interval scan
--                      free on a quiet day. It moves when Terje edits "## Captures", so it is
--                      useless as an arbitration input.
--   payload_digest — TT.vaultPayloadDigest, the SAME 16-bit FNV the bottom anchor carries.
--                      Answers "is this the payload TT recorded at that rev". It has to be the
--                      anchor's hash or the rev-regression split compares against a number no
--                      note ever contained.
CREATE TABLE IF NOT EXISTS vault_index (
  path TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  state TEXT NOT NULL,
  rev INTEGER,
  payload_digest TEXT,
  prev_rev INTEGER,
  prev_payload_digest TEXT,
  file_sha TEXT,
  verified INTEGER,
  quarantine_reason TEXT,
  quarantined_at TEXT,
  seen_at TEXT,
  written_at TEXT
);
`);

// The post-commit queue's state, declared HERE — above every caller, not beside `transaction` at
// the bottom of the file. `let`/`const` are hoisted but left uninitialised, so a reference from a
// function CALLED before the declaration is evaluated throws a TDZ `ReferenceError`; and
// `migrateToSdd002()` a few lines down runs `transaction()` during module init, which is exactly
// that case. See `afterCommit` beside `transaction` for what the queue is for.
let inTransaction = false;
/** @type {(() => void)[]} */
const afterCommitQueue = [];

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
/**
 * The mirror slug a user gets ONCE, at creation (and, for rows that predate the column, at the
 * backfill below). Identical to the expression `mirrorPath` used to evaluate on every write —
 * keeping it identical is what makes this change move zero files. Never call it on an existing
 * row: re-deriving is the defect.
 * @param {{ name?: string | null, email: string }} user @returns {string}
 */
function deriveMirrorSlug(user) {
  return TT.slug(user.name || user.email.split('@')[0]);
}
// SB-112: the mirror filename, PINNED. `mirrorPath` (server/src/markdown.js) used to slug
// `users.name` on every write, which made the filename a function of a mutable field — the one
// derived identifier in this codebase that was re-derived on read. Every other one is settled at
// creation and never recomputed (client ids, `TT.projectCode`, task ids — see DC-005), and this
// column brings the mirror in line with them.
//
// BACKFILLED FROM THE CURRENT NAME, WHICH IS WHY IT MOVES NOTHING. The seed expression below is
// character-for-character what `mirrorPath` computed a moment ago, so every existing user is
// pinned to the file that is already on disk: no rename, no move, no delete, no new orphan, and
// every guard-ledger key stays valid. Verified against the live `users` table before shipping —
// all five rows (Admin, Kari Ansatt, Terje, Terje 2, Review Demo) are pure ASCII, so SB-088's
// transliteration fold changes none of them and the backfill is a no-op on disk.
addColumnIfMissing('users', 'mirror_slug', "TEXT NOT NULL DEFAULT ''");
{
  const unpinned = /** @type {{ id: number, name: string, email: string }[]} */ (
    db.prepare("SELECT id, name, email FROM users WHERE mirror_slug = ''").all()
  );
  const pin = db.prepare('UPDATE users SET mirror_slug = ? WHERE id = ?');
  for (const row of unpinned) pin.run(deriveMirrorSlug(row), row.id);
}
// SB-057 task 8: when a path FIRST quarantined, as opposed to when it was last looked at. The
// surface says "detected <when>" and that has to be sticky — `seen_at` moves on every scan pass,
// including the cheap skip, so it answers a different question. Guarded, because a DB created
// between this plan's task 2 and task 8 already has the table without the column.
addColumnIfMissing('vault_index', 'quarantined_at', 'TEXT');

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
// SB-056 / SB-100: `shape` is stored the same way and defaults to `team` on read, so an
// untouched install behaves exactly as it did before the setting existed. INSTANCE-LOCAL: it,
// `mdDir` and `vaultPaths` stay in these SQLite rows under BOTH shapes and must never be
// serialized into the catalog note (SB-058) — they are how TT finds the catalog, so putting
// them there would be a bootstrap loop. Like `mdDir` it reaches no mirror byte.
//
// SB-100 / DD-016: `vaultCutover` rides beside it and is SERVER-OWNED — see putSettings.
//
// SB-056: `vaultPaths` is the one settings key that is not a scalar. It rides the same
// key/value table as ONE JSON value rather than five keys, because it is one decision — where
// the vault is — and reading it back as a partial (root set, daily missing) would be a shape
// no caller wants to handle. Defaulted on read, validated on write; SB-057/SB-058 may extend
// the shape additively, and an older row missing a newer key simply takes that key's default.
// The defaults live in shared/core.js, next to TT.SHAPES and TT.TIME_SEPARATOR_VALUES — this
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
    shape: 'team',
    // DD-016: `''` is "no cutover has happened", a value nobody can mean — the same trick
    // `mdDir` uses, and the reason this one does NOT need a getStored* twin.
    vaultCutover: '',
    vaultPaths: { ...VAULT_PATHS_DEFAULT },
  };
  for (const row of rows) {
    if (row.key === 'vaultPaths') settings.vaultPaths = parseVaultPaths(row.value);
    else
      settings[/** @type {'currency'|'language'|'mdDir'|'vaultTimeSeparator'|'shape'|'vaultCutover'} */ (row.key)] =
        row.value;
  }
  return /** @type {Settings & { mdDir: string }} */ (/** @type {unknown} */ (settings));
}
/**
 * SB-100: the shape AS STORED — the raw row, or null when nothing has been stored.
 *
 * `getSettings().shape` cannot answer this. It defaults to `team`, which is also a real
 * choice, so "the setting says team" and "there is no setting" are indistinguishable there —
 * and telling them apart is the whole of `shapeTarget()`'s job, since TT_SHAPE is supposed
 * to win exactly when nothing is stored. It is also what makes the OPEN state (DD-015: one
 * user, unlocked, nothing stored) visible to the boot-time inference rule and to SB-098's
 * first-run question. (`mdDir` has no such problem: its default is `''`, a value nobody can
 * mean, which is why `mirrorTarget()` gets away with reading the defaulted object.) An
 * unrecognised row reads as null, so a hand-edited value falls through to the env rather than
 * being trusted.
 * @returns {import('../../shared/types.ts').Shape | null}
 */
export function getStoredShape() {
  const row = /** @type {{ value: string } | undefined} */ (
    db.prepare('SELECT value FROM settings WHERE key = ?').get('shape')
  );
  if (!row || !TT.SHAPES.includes(/** @type {any} */ (row.value))) return null;
  return /** @type {any} */ (row.value);
}
/**
 * SB-100 / DD-016: stamp the moment this install became `personal`, if it has not been
 * stamped. Idempotent, and the FIRST stamp always wins — a round trip through `team` and back
 * must not re-stamp, because a later date silently re-opens history that was already excluded.
 *
 * An ISO INSTANT, not a bare day: DD-016 words the cutover as an instant, and SB-057 (which
 * owns the write filter) can take `slice(0, 10)` for a day-grained comparison against
 * `Entry.date`. Storing the coarser value would throw away information SB-057 cannot recover.
 *
 * Called from two places, because there are two ways into the personal shape: `putSettings`
 * when the shape is stored, and the boot (server/src/index.js) when `TT_SHAPE=personal`
 * supplies it without ever storing anything. An unstamped vault store is one with NO
 * pre-cutover history at all — every entry eligible — which is the hazard inverted.
 * @returns {string} the cutover in force
 */
export function stampVaultCutover() {
  const row = /** @type {{ value: string } | undefined} */ (
    db.prepare('SELECT value FROM settings WHERE key = ?').get('vaultCutover')
  );
  if (row && row.value) return row.value;
  const at = new Date().toISOString();
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('vaultCutover', at);
  return at;
}
/**
 * Writes ONLY the keys that are present, which is what makes a partial legal and always has
 * been — the route hands it whatever the client PUT, and SB-100's boot-time inference hands it
 * `{ shape: 'team' }` and nothing else. The type says so now; the body already did.
 *
 * `vaultPaths` IS PARTIAL TOO, and the type has to say that separately (SB-140). `Settings` types
 * it as a complete `VaultPaths` because every READ hands back a complete one — the validation
 * below RECONSTRUCTS it key by key from `TT.VAULT_PATHS_DEFAULT`, so a caller supplying only
 * `{ root }` is the normal case rather than an edge one, and the first run is exactly that caller.
 * `Partial<Settings>` alone would force it to restate four sub-paths it has no opinion about,
 * which is the drift `TT.VAULT_PATHS_DEFAULT`'s own comment exists to prevent.
 * @param {Partial<Omit<Settings, 'vaultPaths'>> & { vaultPaths?: Partial<import('../../shared/types.ts').VaultPaths> }} settings
 */
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
  // SB-100: same enum discipline. An unrecognised shape name must never reach the table —
  // TT.shapeCapabilities would resolve it to the safe `team` row and the operator would be
  // looking at a stored `persona` believing the vault was live. The vocabulary lives in core.js.
  if (settings.shape != null && TT.SHAPES.includes(settings.shape)) {
    upsert.run('shape', settings.shape);
    // DD-016: the same save that stores `personal` stamps the cutover. HERE and not in the
    // route, so nothing that can store the shape can skip it.
    if (settings.shape === 'personal') stampVaultCutover();
  }
  // `vaultCutover` is deliberately NOT read off `settings`. It is SERVER-OWNED (DD-016): the
  // client PUTs the whole settings object back on every save, so a stamp a client can move is
  // a stamp a client can erase — and the date it would erase is the one deciding which of the
  // user's days may reach the vault at all. See stampVaultCutover.
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
 *
 * SB-075 MADE THE RULE UNIVERSAL — READ THIS BEFORE ADDING A FREE-TEXT COLUMN. SB-072 trimmed
 * only the two fields shown to be UI-reachable, which left the guarantee narrower than it read:
 * `project.name`, `task.label` and `entry.label` still trimmed in the CLIENT alone, so a direct
 * PUT stored padding the mirror ate. All five are now trimmed at this layer, and that is the
 * complete list of trimmed columns today:
 *   `clients.name` (here) · `projects.name` (putProjects) · `tasks.label` (putTasks) ·
 *   `entries.label` + `entries.note` (putEntries)
 * Every OTHER string a mirror section emits is an identifier the caller chose — `clients.id`,
 * `projects.code`, `tasks.id`, `entries.id`, `entries.project` — and those are validated or
 * left verbatim, not normalized. The discipline the ruling bought: any new column whose value
 * reaches a `|`-delimited cell trims here too, or the guarantee quietly narrows again.
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
/** SB-075: `name` is trimmed here for the reason spelled out on putClients above — it is a
 * free-text `|` cell in `## projects`, and ProjectsSection's client-side trim is bypassable
 * by a direct PUT. The `code` beside it is NOT trimmed: it is the caller's identifier and the
 * join key every entry carries, so normalizing it here would silently re-key stored rows.
 * @param {Project[]} projects */
export function putProjects(projects) {
  const insert = db.prepare(
    'INSERT INTO projects (code, name, client_id, rate, billable, archived) VALUES (?, ?, ?, ?, ?, ?)',
  );
  replaceAll('projects', projects, (project) =>
    insert.run(
      String(project.code),
      String(project.name).trim(),
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
 * SB-075: `label` is trimmed here for the reason spelled out on putClients above — it is a
 * free-text `|` cell in `## tasks`, and TaskModal's client-side trim is bypassable by a
 * direct PUT. `id` and `project` are identifiers and stay verbatim.
 * @param {number} userId @param {Task[]} tasks */
export function putTasks(userId, tasks) {
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO tasks (user_id, id, label, project_code) VALUES (?, ?, ?, ?)');
  for (const task of tasks) {
    insert.run(userId, String(task.id), String(task.label).trim(), task.project == null ? null : String(task.project));
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
// SB-072/SB-075: the free-text pair `label` and `note` are the exception — they are NORMALIZED
// here rather than rejected, because the mirror parser trims every cell it splits out and so
// silently eats their leading/trailing whitespace on a restore. (SB-072 did `note`; SB-075 added
// `label`, which until then trimmed in the client only and so lost the guarantee to any direct
// PUT.) Trimming on the way in keeps the DB inside what the format can represent; see the
// putClients comment for the full ruling and the complete list of trimmed columns. Normalization
// sits at this layer (all write paths, including the admin cross-user one and the demo seed)
// while rejection sits at the API boundary, where it can return an error. Interior whitespace is
// untouched, and `date`/`project` stay verbatim — they are not free text.
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
      String(entry.label ?? '').trim(),
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

// ---- vault index (SB-057) ----
// See the DDL above for what this table is and is not. These are the only accessors; nothing
// else may touch `vault_index`, because `putVaultIndex` owns a rule no caller can be trusted to
// reproduce (the previous-pair roll-forward below).
/** @typedef {import('../../shared/types.ts').VaultIndexRow} VaultIndexRow */

/** The three legal `state` values. Only `known` licenses a write (design decision 2). */
const VAULT_INDEX_STATES = ['known', 'unknown', 'quarantined'];

/**
 * The raw SQLite row as the model shape. `verified` is stored as 0/1/NULL and comes back as a
 * boolean or null — null means "TT has not parsed this file", which is a third thing and not
 * `false` ("parsed, digest-less, therefore unverified").
 * @param {any} row @returns {VaultIndexRow | null}
 */
function vaultIndexRow(row) {
  if (!row) return null;
  return {
    path: row.path,
    date: row.date,
    state: row.state,
    rev: row.rev,
    payloadDigest: row.payload_digest,
    prevRev: row.prev_rev,
    prevPayloadDigest: row.prev_payload_digest,
    fileSha: row.file_sha,
    verified: row.verified == null ? null : !!row.verified,
    quarantineReason: row.quarantine_reason,
    quarantinedAt: row.quarantined_at,
    seenAt: row.seen_at,
    writtenAt: row.written_at,
  };
}
const VAULT_INDEX_SELECT =
  'SELECT path, date, state, rev, payload_digest, prev_rev, prev_payload_digest, file_sha, verified, quarantine_reason, quarantined_at, seen_at, written_at FROM vault_index';

/** @param {string} path @returns {VaultIndexRow | null} */
export function getVaultIndex(path) {
  return vaultIndexRow(db.prepare(VAULT_INDEX_SELECT + ' WHERE path = ?').get(String(path)));
}
/**
 * Every row TT holds for one calendar date. A LIST and not a single row: the daily folder is a
 * setting, so re-pointing it leaves rows for two paths that mean the same day, and a caller that
 * assumed one row would silently pick whichever SQLite handed back first.
 * @param {string} date @returns {VaultIndexRow[]}
 */
export function getVaultIndexByDate(date) {
  return /** @type {VaultIndexRow[]} */ (
    db
      .prepare(VAULT_INDEX_SELECT + ' WHERE date = ? ORDER BY path')
      .all(String(date))
      .map(vaultIndexRow)
  );
}
/** @returns {VaultIndexRow[]} */
export function listVaultIndex() {
  return /** @type {VaultIndexRow[]} */ (
    db
      .prepare(VAULT_INDEX_SELECT + ' ORDER BY path')
      .all()
      .map(vaultIndexRow)
  );
}
/**
 * Record what TT now knows about a path. THE ONE PLACE `prevRev`/`prevPayloadDigest` are set —
 * they are rolled forward from the row's CURRENT pair and are deliberately not readable off the
 * argument. A caller that could set them would eventually set them to something that never was
 * on disk, and the rev-regression split (design decision 5) would then vouch for a payload TT
 * never wrote, which is the silent-undo SB-061 filed.
 *
 * The roll happens only when the incoming `(rev, payloadDigest)` DIFFERS from the stored pair.
 * An idempotent re-put — the interval scan touching `seenAt` on a file that has not moved — must
 * not shift `(rev, digest)` into `prev_*`, because that would overwrite the genuine previous
 * revision with the current one and turn a legitimate stale peer into a quarantine. "Exactly one
 * previous pair" means one previous DISTINCT pair.
 *
 * An unrecognised `state` degrades to `unknown` rather than throwing or being stored verbatim.
 * `unknown` is the safe row: it licenses no write, so a junk value costs a re-read and never a
 * byte. Same discipline `putSettings` applies to `shape`.
 * @param {VaultIndexRow} row
 */
export function putVaultIndex(row) {
  const path = String(row.path);
  const current = getVaultIndex(path);
  const rev = row.rev == null ? null : +row.rev;
  const payloadDigest = row.payloadDigest == null ? null : String(row.payloadDigest);
  const changed = !current || current.rev !== rev || current.payloadDigest !== payloadDigest;
  const prevRev = current ? (changed ? current.rev : current.prevRev) : null;
  const prevDigest = current ? (changed ? current.payloadDigest : current.prevPayloadDigest) : null;
  const state = VAULT_INDEX_STATES.includes(String(row.state)) ? String(row.state) : 'unknown';
  // `quarantinedAt` is OWNED here for the same reason the previous pair is: it is the moment the
  // refusal STARTED, and a caller that could set it could make a standing quarantine look new on
  // every scan pass. Stamped on the transition INTO `quarantined`, preserved while it stays there,
  // and cleared when the note recovers.
  const quarantinedAt =
    state !== 'quarantined' ? null : current && current.state === 'quarantined' && current.quarantinedAt ? current.quarantinedAt : new Date().toISOString(); // prettier-ignore
  // …and the REASON is tied to the state for the same reason, in the same place. A scan pass that
  // takes the cheap `file_sha` exit re-puts the row without re-deriving why it was refused — and a
  // quarantine with no reason renders as the generic "did not say why" line, which is a surface
  // that has stopped telling the truth about a note that has stopped syncing. Caught by looking at
  // the screen, not by a test. Absent + still quarantined ⇒ keep what was there; not quarantined ⇒
  // always null, so a recovered note cannot carry a stale reason.
  const quarantineReason =
    state !== 'quarantined'
      ? null
      : row.quarantineReason != null
        ? String(row.quarantineReason)
        : current && current.quarantineReason
          ? current.quarantineReason
          : null;
  db.prepare(
    `INSERT INTO vault_index (path, date, state, rev, payload_digest, prev_rev, prev_payload_digest, file_sha, verified, quarantine_reason, quarantined_at, seen_at, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       date = excluded.date, state = excluded.state, rev = excluded.rev,
       payload_digest = excluded.payload_digest, prev_rev = excluded.prev_rev,
       prev_payload_digest = excluded.prev_payload_digest, file_sha = excluded.file_sha,
       verified = excluded.verified, quarantine_reason = excluded.quarantine_reason,
       quarantined_at = excluded.quarantined_at, seen_at = excluded.seen_at,
       written_at = excluded.written_at`,
  ).run(
    path,
    String(row.date ?? ''),
    state,
    rev,
    payloadDigest,
    prevRev,
    prevDigest,
    row.fileSha == null ? null : String(row.fileSha),
    row.verified == null ? null : row.verified ? 1 : 0,
    quarantineReason,
    quarantinedAt,
    row.seenAt == null ? null : String(row.seenAt),
    row.writtenAt == null ? null : String(row.writtenAt),
  );
}
/** @param {string} path */
export function deleteVaultIndex(path) {
  db.prepare('DELETE FROM vault_index WHERE path = ?').run(String(path));
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
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanName = String(name).trim();
  const result = db
    .prepare('INSERT INTO users (email, name, role, password_hash, mirror_slug) VALUES (?, ?, ?, ?, ?)')
    .run(
      cleanEmail,
      cleanName,
      role === 'admin' ? 'admin' : 'employee',
      hashPassword(password),
      // SB-112: settled here and never again, so a later rename cannot fork the mirror file.
      deriveMirrorSlug({ name: cleanName, email: cleanEmail }),
    );
  return findUserById(result.lastInsertRowid);
}

/**
 * SB-112: the pinned filename component for this user's markdown mirror, or null if the row is
 * somehow unpinned (a hand-edited database — the migration covers every row it can see). Read by
 * `mirrorPath`, which falls back to the old live derivation on null so an unpinned row keeps
 * writing exactly where it writes today rather than jumping to a new file.
 *
 * NOT ON THE WIRE, and not on the `User` type, deliberately: this is a storage detail of one
 * machine's mirror folder, and DD-015's lesson is that a derived storage fact does not belong in
 * the envelope just because it was convenient to put it there. `mirrorPath` looks it up.
 * @param {number} id @returns {string | null}
 */
export function getMirrorSlug(id) {
  const row = /** @type {{ mirror_slug: string } | undefined} */ (
    db.prepare('SELECT mirror_slug FROM users WHERE id = ?').get(id)
  );
  return row && row.mirror_slug ? row.mirror_slug : null;
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
  inTransaction = true;
  try {
    const r = fn();
    db.exec('COMMIT');
    inTransaction = false;
    // AFTER the COMMIT, never inside it. See `afterCommit` below.
    flushAfterCommit();
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    inTransaction = false;
    // A rolled-back write never happened, so neither may its side effects. Dropping the queue is
    // the whole reason it exists: the alternative is daily notes on disk describing entries the
    // database no longer holds.
    afterCommitQueue.length = 0;
    throw err;
  }
}

// ---- side effects that must not run inside a transaction (SB-057) ----
//
// The vault fan-out writes FILES — an fsync of the note, an fsync of its directory, and (once
// SB-068 lands) a `git add -A` over the whole vault. None of that may happen while a SQLite write
// transaction is open, for two reasons and the first is the serious one:
//
//   • ROLLBACK. `store.putEntries` is called from inside `store.transaction(...)` in the API layer,
//     and the transaction continues after it (`putCommits`, the version bumps). A throw anywhere
//     after the fan-out would roll SQLite back while the daily notes — and TT's own git checkpoint
//     — are already on disk and fsynced. The vault would then describe entries the index does not
//     hold, which is the one direction DD-006's "SQLite is the derived index" cannot survive.
//   • HOLD TIME. Two fsyncs per touched date, with a write transaction held open throughout.
//
// So the fan-out is QUEUED here and flushed after the COMMIT — the same position in the sequence
// the markdown mirror already occupies (the routes call `store.mirror` after the transaction), and
// the reason is identical. Called outside a transaction it simply runs, so a caller that is not in
// one is not silently deferred forever.
//
// A queued effect that throws is logged and the rest still run: by then the save HAS committed, and
// "you cannot save at all" is a strictly worse failure than a note that has stopped syncing
// (SB-065's posture).
/** @param {() => void} fn */
export function afterCommit(fn) {
  if (!inTransaction) {
    fn();
    return;
  }
  afterCommitQueue.push(fn);
}
function flushAfterCommit() {
  const queued = afterCommitQueue.splice(0, afterCommitQueue.length);
  for (const fn of queued) {
    try {
      fn();
    } catch (err) {
      console.error('[time-turtle] post-commit side effect failed:', /** @type {Error} */ (err).message);
    }
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
    // DD-024 clause 3: the demo half is opt-in now and lives in its own function, so the first-run
    // answer can call it after boot. `TT_SEED_DEMO=1` keeps seeding here for tests and scripts.
    if (SEED_DEMO) seedDemoContent();
  }
}

/**
 * DD-024 clause 3: the demo catalog and hours, as a SEPARATELY CALLABLE step.
 *
 * WHY IT LEFT `seedIfEmpty`'s user-count branch, and this is the whole of SB-146's fix. The trap
 * is a SEQUENCING window, not a bug in any one function: this ran at boot while the shape was
 * still `default`, `TT.seedMd()` dates its entries at `T`, `T-1`, `T-2`, `T-7`, `T-8`, `T-9`, and
 * `putSettings` stamped the DD-016 cutover seconds later when `personal` was stored. Eight rows
 * landed pre-cutover and DD-017 §1 correctly froze them forever — demo data the person could never
 * delete. Run it AFTER the answer instead and the window does not exist: under `personal` it is
 * refused outright, and under `team` there is no cutover for anything to be before.
 *
 * SB-146's OTHER CANDIDATE — stamp the cutover before the seed — is deliberately NOT built. It
 * makes the demo rows POST-cutover and therefore eligible to be written into real daily notes,
 * which is DD-016's first named hazard verbatim.
 *
 * ADMIN CREATION DID NOT MOVE and must not: every join is keyed `user_id` and three separate
 * guards assume the row exists.
 *
 * IDEMPOTENT ON PROJECT COUNT, which it already was — that is what makes it safe to call again
 * after a boot that did not seed.
 * @returns {boolean} whether anything was seeded
 */
export function seedDemoContent() {
  const projectCount = /** @type {{ n: number }} */ (db.prepare('SELECT COUNT(*) AS n FROM projects').get());
  if (projectCount.n !== 0) return false;
  // The seeded admin — `seedIfEmpty` guarantees a row, and in the open state there is exactly one.
  const owner = listUsers()[0];
  if (!owner) return false;
  const seedState = TT.seed();
  transaction(() => {
    putSettings(seedState.settings);
    putClients(seedState.clients);
    putProjects(seedState.projects);
    putTasks(owner.id, seedState.tasks);
    putEntries(owner.id, seedState.entries);
  });
  console.log('[time-turtle] seeded demo data (opt-in: TT_SEED_DEMO=1, or the first run’s demo step)');
  return true;
}
