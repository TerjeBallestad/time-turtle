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
  const h = String(host)
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127\./.test(h);
}

// ---- SB-136: the Host header the implicit local session will answer to ----
//
// A strict dotted quad inside 127.0.0.0/8 (RFC 1122). Every octet is bounded, and the anchors
// are the point: a DOMAIN NAME must not be able to satisfy it.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_LOOPBACK = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
/**
 * Whether a request's `Host` header names this machine's own loopback. The guard on the
 * implicit local session — see `requireUser` in index.js, which is its only caller.
 *
 * WHY IT EXISTS. Under `personal` there is no cookie to be missing (SB-098), so the loopback
 * bind above is the only thing between the API and a caller. Loopback stops another machine on
 * the wifi. It does NOT stop a web page the user merely visited, because DNS REBINDING DEFEATS
 * LOOPBACK: an attacker domain that re-resolves to 127.0.0.1 is same-origin as far as the
 * browser is concerned, so there is no preflight to fail and no opaque response to hide behind,
 * and the whole API becomes readable AND writable by that page. The one thing such a page
 * cannot forge is the `Host` header — the browser sends the attacker's own domain — so refusing
 * a `Host` that is not loopback is the standard mitigation, and it costs nothing.
 *
 * WHAT IT STILL DOES NOT COVER, deliberately: another PROGRAM on the same machine can send any
 * Host it likes, and DD-015 depth 2 already accepts that — a local process that wants your
 * hours can read `timeturtle.db` directly.
 *
 * IT IS NOT `isLoopbackHost` ABOVE, AND MUST NOT BE FOLDED INTO IT. That one reads an
 * OPERATOR-SUPPLIED `TT_HOST` and can afford a loose `/^127\./`; this one reads an
 * ATTACKER-SUPPLIED header, where `127.0.0.1.evil.example` — a name anybody can register and
 * point at 127.0.0.1 — sails through that prefix test. Everything accepted below is either an
 * exact literal or a strict dotted quad that no hostname can be.
 *
 * THE PORT IS THE EASY THING TO GET WRONG. A Host header is `host` or `host:port`, and an IPv6
 * literal is bracketed (RFC 3986) — so `[::1]:3001` has three colons and splitting on the last
 * one is nonsense on `[::1]` alone. Brackets are matched first, and an UNBRACKETED value with a
 * non-numeric tail after its colon is refused rather than guessed at.
 *
 * A MISSING OR EMPTY HOST REFUSES. Every browser and every real client sends one; absence is
 * either a hand-rolled caller or an attempt to slip past exactly this check.
 * @param {unknown} raw the raw `Host` header @returns {boolean}
 */
export function isLoopbackHostHeader(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return false;
  let name;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return false;
    const after = value.slice(close + 1);
    if (after !== '' && !/^:\d+$/.test(after)) return false;
    name = value.slice(1, close).toLowerCase();
  } else {
    const colon = value.indexOf(':');
    if (colon !== -1 && !/^\d+$/.test(value.slice(colon + 1))) return false;
    name = (colon === -1 ? value : value.slice(0, colon)).toLowerCase();
  }
  return name === 'localhost' || name === '::1' || name === '::ffff:127.0.0.1' || IPV4_LOOPBACK.test(name);
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
