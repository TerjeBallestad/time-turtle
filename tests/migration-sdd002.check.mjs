// SDD-002 one-shot v1→v2 migration check (judge-ladder: targeted node script over db.js).
//
// Run under PLAIN NODE, not vitest — db.js uses node:sqlite, which vite's transform
// can't load (that is why api.test.js / md-dir-lock.test.js spawn the server as a
// child node process rather than importing it). This script builds a V1-shaped
// database, boots db.js against it (the migration runs at import), and asserts the
// copied-at-birth result. Exits non-zero on any failed assertion.
//
//   node tests/migration-sdd002.check.mjs
//
// ## Verified red-green: 2026-07-23
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'tt-mig-'));
process.env.TT_DATA_DIR = DATA_DIR;
process.env.TT_SEED_DEMO = '0';

let failures = 0;
function check(name, cond) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.error('  ✗ ' + name);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- build a V1-shaped database (old shared tasks, entries with task_id, no billable) ---
const raw = new DatabaseSync(join(DATA_DIR, 'timeturtle.db'));
raw.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    role TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, rounding TEXT NOT NULL DEFAULT 'exact', rate REAL);
  CREATE TABLE projects (code TEXT PRIMARY KEY, name TEXT NOT NULL, client_id TEXT, rate REAL);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_code TEXT, billable INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE entries (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, date TEXT NOT NULL, start INTEGER, end INTEGER,
    dur_min INTEGER, task_id TEXT, note TEXT NOT NULL DEFAULT '', billable INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE versions (scope TEXT PRIMARY KEY, version INTEGER NOT NULL);
`);
raw.exec(`INSERT INTO users (id, email, name, role, password_hash) VALUES
  (1, 'admin@x', 'Admin', 'admin', 'x'), (2, 'emp@x', 'Emp', 'employee', 'x')`);
raw.exec(`INSERT INTO clients (id, name, rounding, rate) VALUES ('fjellheim', 'Fjellheim AS', '15', 1250)`);
raw.exec(`INSERT INTO projects (code, name, client_id, rate) VALUES
  ('FJH-NETT', 'Nett', 'fjellheim', NULL), ('INT-ADM', 'Internal', NULL, NULL)`);
raw.exec(`INSERT INTO tasks (id, name, project_code, billable) VALUES
  ('checkout', 'Checkout flow', 'FJH-NETT', 1), ('admin', 'Admin & invoicing', 'INT-ADM', 0)`);
// admin: a checkout range + an admin nb duration; employee: a checkout range + a DANGLING task ref
raw.exec(`INSERT INTO entries (id, user_id, date, start, end, dur_min, task_id, note, billable) VALUES
  ('a1', 1, '2026-01-05', 540, 930, NULL, 'checkout', 'ia', 1),
  ('a2', 1, '2026-01-05', NULL, NULL, 45, 'admin', 'invoicing', 0),
  ('b1', 2, '2026-01-06', 510, 720, NULL, 'checkout', 'wire', 1),
  ('b2', 2, '2026-01-06', NULL, NULL, 60, 'ghosttask', 'orphan work', 1)`);
raw.close();

// --- boot db.js against it (migration runs at import) ---
const db = await import('../server/src/db.js');
const TT = (await import('../shared/core.js')).default;

const admin = db.getEntries(1);
const emp = db.getEntries(2);
const a1 = admin.find((e) => e.id === 'a1');
const a2 = admin.find((e) => e.id === 'a2');
const b2 = emp.find((e) => e.id === 'b2');

console.log('SDD-002 migration:');
check(
  'entry a1: checkout label + FJH-NETT project copied on',
  a1.project === 'FJH-NETT' && a1.label === 'Checkout flow',
);
check('entry a2: frozen non-billable preserved (billable=false)', a2.billable === false && a2.project === 'INT-ADM');
check('entry b2: dangling id → label=raw id, project=null', b2.project === null && b2.label === 'ghosttask');
check(
  'admin templates seeded per-user = [admin, checkout]',
  eq(
    db
      .getTasks(1)
      .map((t) => t.id)
      .sort(),
    ['admin', 'checkout'],
  ),
);
check(
  'employee templates = [checkout, ghosttask] (no cross-user bleed)',
  eq(
    db
      .getTasks(2)
      .map((t) => t.id)
      .sort(),
    ['checkout', 'ghosttask'],
  ),
);
check(
  'template shape {id,label,project} — no billable/name',
  db.getTasks(1).every((t) => 'label' in t && !('billable' in t) && !('name' in t)),
);
check(
  'all projects billable after migration',
  db.getProjects().every((p) => p.billable === true),
);

const state = {
  settings: db.getSettings(),
  clients: db.getClients(),
  projects: db.getProjects(),
  tasks: db.getTasks(1),
  entries: [],
};
// 09:00→15:30 = 390 min; fjellheim rounds 15 (390 already a multiple); rate 1250 — unchanged from v1
check('billing unchanged: billMinutes(a1) === 390', TT.billMinutes(state, a1) === 390);
check('billing unchanged: amount(a1) === 390/60*1250', TT.amount(state, a1) === (390 / 60) * 1250);

console.log(failures ? `\nFAILED (${failures})` : '\nOK — all migration assertions passed');
process.exit(failures ? 1 : 0);
