// @ts-check
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { SECRET, PORT } from './config.js';

// SB-014: cookies are scoped by host, not port, so two dev instances on localhost
// share one cookie and clobber each other's session. Suffix the cookie name with the
// port for non-default instances; the default instance keeps the bare name so its
// existing sessions survive. (Each instance still has its own SECRET, so a shared
// cookie would fail HMAC verification and 401 every request.)
const COOKIE_NAME = PORT === 3001 ? 'tt_session' : 'tt_session_' + PORT;

// ---- passwords: scrypt with per-user salt ----
/** @param {string} password @returns {string} */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 32).toString('hex');
  return salt + ':' + hash;
}
/** @param {string} password @param {string} stored @returns {boolean} */
export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(String(password), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---- session tokens: HMAC-signed "userId.tokenVersion.expiryMs.sig" cookie ----
// SB-013: tokenVersion is a per-user counter (users.token_version) bumped on every
// password change. It rides inside the signed payload so requireUser can reject any
// token minted before the current version — that is what logs stale sessions out.
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** @param {string} payload @returns {string} */
function sign(payload) {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}
/** @param {number} userId @param {number} tokenVersion @returns {string} */
export function makeToken(userId, tokenVersion) {
  const payload = userId + '.' + tokenVersion + '.' + (Date.now() + SESSION_MS);
  return payload + '.' + sign(payload);
}
/** @param {string} token @returns {{ userId: number, tokenVersion: number } | null} */
export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null;
  const payload = parts[0] + '.' + parts[1] + '.' + parts[2];
  const expected = sign(payload);
  const got = Buffer.from(parts[3]);
  if (got.length !== Buffer.from(expected).length || !timingSafeEqual(got, Buffer.from(expected))) return null;
  if (+parts[2] < Date.now()) return null;
  return { userId: +parts[0], tokenVersion: +parts[1] };
}

/** @param {import('express').Request} req @returns {{ userId: number, tokenVersion: number } | null} */
export function readSessionCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return verifyToken(decodeURIComponent(v.join('=')));
  }
  return null;
}
/** @param {string} token @returns {string} */
export function sessionCookie(token) {
  const attrs = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_MS / 1000;
  return COOKIE_NAME + '=' + encodeURIComponent(token) + '; ' + attrs;
}
export const clearCookie = COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
