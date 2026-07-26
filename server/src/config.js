// @ts-check
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import TT from '../../shared/core.js';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.TT_DATA_DIR ? resolve(process.env.TT_DATA_DIR) : join(serverDir, 'data');
export const DB_PATH = join(DATA_DIR, 'timeturtle.db');
// Markdown mirror directory — point this at a folder in your Obsidian vault if you like.
export const MD_DIR = process.env.TT_MD_DIR ? resolve(process.env.TT_MD_DIR) : join(DATA_DIR, 'markdown');
// Whether MD_DIR came from TT_MD_DIR or is just the default — the startup banner names
// the source of the effective mirror path, and "your TT_MD_DIR lost" is worth saying out
// loud (SB-073).
export const MD_DIR_FROM_ENV = !!process.env.TT_MD_DIR;
// DC-002: Settings → Mirror folder makes the server mkdir/write at an arbitrary path, which
// is fine when admin == machine owner but a footgun on a shared box. Set TT_MD_DIR_LOCK to
// freeze the mirror at MD_DIR: the stored setting is then ignored and rejected on write.
export const MD_DIR_LOCKED = !!process.env.TT_MD_DIR_LOCK && process.env.TT_MD_DIR_LOCK !== '0';

// ---- SB-056: the storage backend, modelled line for line on MD_DIR above (DC-002) ----
// TT_BACKEND supplies the DEFAULT; a stored `Settings.backend` beats it; TT_BACKEND_LOCK
// freezes the env value so the stored setting is both ignored and rejected on write. See
// backendTarget() in ./backend.js for the resolution, which is mirrorTarget()'s twin.
//
// An unrecognised TT_BACKEND fails LOUDLY here rather than falling back to sqlite. A typo
// (`TT_BACKEND=valut`) that silently means sqlite is the worst possible reading: the operator
// believes the vault is live, the mirror keeps writing into the vault, and nothing says so.
if (process.env.TT_BACKEND && !TT.BACKENDS.includes(/** @type {any} */ (process.env.TT_BACKEND))) {
  console.error(
    `[time-turtle] TT_BACKEND=${JSON.stringify(process.env.TT_BACKEND)} is not a storage backend — expected one of ${TT.BACKENDS.join(', ')}`,
  );
  process.exit(1);
}
/** @type {import('../../shared/types.ts').Backend} */
export const BACKEND = /** @type {any} */ (process.env.TT_BACKEND || 'sqlite');
/** Whether BACKEND came from TT_BACKEND or is just the default — the banner names the source (SB-073). */
export const BACKEND_FROM_ENV = !!process.env.TT_BACKEND;
// DC-002: `TT_BACKEND_LOCK=1 TT_BACKEND=sqlite` is the ONLY way out of an install whose stored
// setting says `vault` and whose user table says otherwise (a copied data dir, say) — it is the
// recovery string the boot refusal prints. Do NOT "simplify" the lock into an env default: a
// default loses to the stored setting, and losing to the stored setting is the wedge.
export const BACKEND_LOCKED = !!process.env.TT_BACKEND_LOCK && process.env.TT_BACKEND_LOCK !== '0';

export const PORT = +(process.env.PORT || 3001);
export const ADMIN_EMAIL = process.env.TT_ADMIN_EMAIL || 'admin@timeturtle.local';
export const ADMIN_PASSWORD = process.env.TT_ADMIN_PASSWORD || 'turtle';
export const SEED_DEMO = process.env.TT_SEED_DEMO !== '0';

// Session-signing secret: env override, else generated once and stored next to the DB.
mkdirSync(DATA_DIR, { recursive: true });
function loadSecret() {
  if (process.env.TT_SECRET) return process.env.TT_SECRET;
  const p = join(DATA_DIR, '.secret');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(p, s, { mode: 0o600 });
  return s;
}
export const SECRET = loadSecret();
