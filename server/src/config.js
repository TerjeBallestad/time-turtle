// @ts-check
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.TT_DATA_DIR ? resolve(process.env.TT_DATA_DIR) : join(serverDir, 'data');
export const DB_PATH = join(DATA_DIR, 'timeturtle.db');
// Markdown mirror directory — point this at a folder in your Obsidian vault if you like.
export const MD_DIR = process.env.TT_MD_DIR ? resolve(process.env.TT_MD_DIR) : join(DATA_DIR, 'markdown');
// DC-002: Settings → Mirror folder makes the server mkdir/write at an arbitrary path, which
// is fine when admin == machine owner but a footgun on a shared box. Set TT_MD_DIR_LOCK to
// freeze the mirror at MD_DIR: the stored setting is then ignored and rejected on write.
export const MD_DIR_LOCKED = !!process.env.TT_MD_DIR_LOCK && process.env.TT_MD_DIR_LOCK !== '0';
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
