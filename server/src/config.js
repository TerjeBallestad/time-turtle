// @ts-check
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.TT_DATA_DIR ? resolve(process.env.TT_DATA_DIR) : join(serverDir, 'data');
export const DB_PATH = join(DATA_DIR, 'timeturtle.db');

// SB-181: variables an older Time Turtle read. Setting one is harmless, so the boot says so once
// per variable and carries on — it never exits for them.
const REMOVED_ENV = {
  TT_SHAPE: 'the shape concept was removed',
  TT_SHAPE_LOCK: 'the shape concept was removed',
  TT_MD_DIR: 'the markdown mirror was removed',
  TT_MD_DIR_LOCK: 'the markdown mirror was removed',
  TT_OBSIDIAN_REGISTRY: 'the Obsidian vault support was removed',
};
for (const [name, why] of Object.entries(REMOVED_ENV)) {
  if (process.env[name] !== undefined) console.log(`[time-turtle] ${name} is set but no longer read — ${why}`);
}

export const PORT = +(process.env.PORT || 3001);
// Which interfaces the server answers on. Unset means every interface: a team install is reached
// from other machines by definition. `TT_HOST=127.0.0.1` keeps it to this machine.
export const HOST = process.env.TT_HOST || '';

// ---- SB-136: the Host header the first run will answer to ----
//
// A strict dotted quad inside 127.0.0.0/8 (RFC 1122). Every octet is bounded, and the anchors
// are the point: a DOMAIN NAME must not be able to satisfy it.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_LOOPBACK = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
/**
 * Whether a request's `Host` header names this machine's own loopback. One half of the first-run
 * caller gate — see `firstRunCaller` in index.js, which is its only caller.
 *
 * WHY IT EXISTS. The first run takes no credential, so the address checks are all that stand
 * between it and a caller. The peer check stops another machine on the wifi. It does NOT stop a web
 * page the user merely visited, because DNS REBINDING DEFEATS LOOPBACK: an attacker domain that
 * re-resolves to 127.0.0.1 is same-origin as far as the browser is concerned. The one thing such a
 * page cannot forge is the `Host` header — the browser sends the attacker's own domain — so refusing
 * a `Host` that is not loopback is the standard mitigation, and it costs nothing.
 *
 * WHAT IT STILL DOES NOT COVER, deliberately: another PROGRAM on the same machine can send any
 * Host it likes — and a local process that wants your hours can read `timeturtle.db` directly.
 *
 * IT READS AN ATTACKER-SUPPLIED HEADER, so it is strict: `127.0.0.1.evil.example` — a name anybody
 * can register and point at 127.0.0.1 — must not pass a prefix test. Everything accepted below is
 * either an exact literal or a strict dotted quad that no hostname can be.
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
// ---- DD-024 clause 1 / SB-162: the address the request actually came FROM ----
//
// A second loopback predicate, on purpose. `isLoopbackHostHeader` reads an ATTACKER-SUPPLIED
// header; this one reads a KERNEL-SUPPLIED peer address. Two sources, two trust levels, two
// functions — folding them together would make one function answer questions with different
// answers.
//
// WHY IT HAS TO EXIST AT ALL, and it is not defence in depth. With no `TT_HOST` the server listens
// on EVERY INTERFACE while it serves a first run that takes no credential. SB-162 is the measured
// proof that the Host header cannot stand in for this: `curl -H 'Host: localhost'
// http://<lan-ip>:<port>/…` passes a Host check from another machine on the wifi.
// The Host header still stops what this cannot — DNS rebinding in the user's own browser arrives
// over loopback, so the peer address is loopback and only the header gives it away. Neither guard
// replaces the other and deleting either re-opens an attack the other never covered.
//
// UNLIKE THE HEADER PREDICATE, THE INPUT HERE IS NOT FORGEABLE. `req.socket.remoteAddress` comes
// from the kernel, and `server/src/` sets no `trust proxy` and reads no `X-Forwarded-*` anywhere,
// so no header can move it. The strictness below therefore buys correctness rather than safety —
// a hostname cannot appear here — but it is written strictly anyway so that reading one predicate
// never teaches a wrong lesson about the other.
//
// Node reports an IPv4 peer on a dual-stack socket as `::ffff:127.0.0.1`, which is why the mapped
// form is matched rather than assumed away.
/**
 * Whether a request's PEER ADDRESS is this machine itself.
 * @param {unknown} raw `req.socket.remoteAddress` @returns {boolean}
 */
export function isLoopbackPeer(raw) {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!value) return false; // a socket with no peer address is not one we can vouch for
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : value;
  return value === '::1' || IPV4_LOOPBACK.test(mapped);
}

export const ADMIN_EMAIL = process.env.TT_ADMIN_EMAIL || 'admin@timeturtle.local';
// ---- DD-024 clause 2: the ONE password this repo may ever read out to a screen ----
//
// Named, rather than inlined into the line below, because a second surface now reads it: the
// Login screen states this credential back to a loopback caller while the seeded admin still
// carries it (`defaultLogin` on `GET /api/first-run`). That is only safe for THIS literal — it is
// a constant in a public MIT repo (DD-004), so stating it discloses nothing the source does not.
// An operator's `TT_ADMIN_PASSWORD` is a real secret and must never reach a screen, which is why
// the hint verifies against this constant and never against `ADMIN_PASSWORD`.
export const DEFAULT_ADMIN_PASSWORD = 'turtle';
export const ADMIN_PASSWORD = process.env.TT_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
// ---- DD-024 clause 3: demo content is a step you ask for, not one you opt out of ----
//
// Terje ruled the direction on SB-159 ("Create demo content — don't spawn it by default"). The
// first run's demo step asks for it; `TT_SEED_DEMO=1` seeds at boot for tests and scripts.
export const SEED_DEMO = process.env.TT_SEED_DEMO === '1';

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
