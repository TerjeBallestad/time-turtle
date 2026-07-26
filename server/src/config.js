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

// ---- SB-056 / SB-100: the instance SHAPE, modelled line for line on MD_DIR above (DC-002) ----
// TT_SHAPE supplies the DEFAULT; a stored `Settings.shape` beats it; TT_SHAPE_LOCK freezes the
// env value so the stored setting is both ignored and rejected on write. See shapeTarget() in
// ./backend.js for the resolution, which is mirrorTarget()'s twin. The storage backend is
// DERIVED from the shape (DD-015) and has no env var of its own — there is nothing to select.
//
// An unrecognised TT_SHAPE fails LOUDLY here rather than falling back to `team`. A typo
// (`TT_SHAPE=persona`) that silently means `team` is the worst possible reading: the operator
// believes the vault is live, the mirror keeps writing into the vault, and nothing says so.
if (process.env.TT_SHAPE && !TT.SHAPES.includes(/** @type {any} */ (process.env.TT_SHAPE))) {
  console.error(
    `[time-turtle] TT_SHAPE=${JSON.stringify(process.env.TT_SHAPE)} is not an instance shape — expected one of ${TT.SHAPES.join(', ')}`,
  );
  process.exit(1);
}
/** @type {import('../../shared/types.ts').Shape} */
export const SHAPE = /** @type {any} */ (process.env.TT_SHAPE || 'team');
/** Whether SHAPE came from TT_SHAPE or is just the default — the banner names the source (SB-073). */
export const SHAPE_FROM_ENV = !!process.env.TT_SHAPE;
// DC-002: `TT_SHAPE_LOCK=1 TT_SHAPE=team` is the ONLY way out of an install whose stored
// setting says `personal` and whose user table says otherwise (a copied data dir, say) — it is
// the recovery string the boot refusal prints. Do NOT "simplify" the lock into an env default:
// a default loses to the stored setting, and losing to the stored setting is the wedge.
export const SHAPE_LOCKED = !!process.env.TT_SHAPE_LOCK && process.env.TT_SHAPE_LOCK !== '0';

export const PORT = +(process.env.PORT || 3001);
// ---- SB-098: which interfaces the server answers on ----
//
// Unset means what `app.listen(PORT)` has always meant — every interface — and that stays the
// `team` default: a company install is reached from other machines by definition.
//
// It exists at all because the personal shape has no login (DD-015 depth 2), and "no login"
// on 0.0.0.0 means no login FOR ANYONE ON THE SAME WIFI. Under `personal` the bind is forced
// to loopback, and a TT_HOST that names anything else is a REFUSAL TO START rather than a
// silently ignored value — see the boot block in index.js. Ignoring it would be the worse
// reading: an operator who typed TT_HOST=0.0.0.0 believes the box is reachable, and the one
// thing they must not be wrong about is who can reach an unauthenticated timesheet.
export const HOST = process.env.TT_HOST || '';
/**
 * Whether an address is loopback — the only bind the personal shape permits. `localhost` is
 * included because it is what a person types; it resolves to 127.0.0.1/::1 and nothing else.
 * The `127.` net is loopback in its entirety (RFC 1122), so 127.0.0.2 is as safe as 127.0.0.1.
 * @param {string} host @returns {boolean}
 */
export function isLoopbackHost(host) {
  const h = String(host).trim().replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127\./.test(h);
}
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
