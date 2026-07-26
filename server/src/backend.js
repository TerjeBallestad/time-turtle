// @ts-check
// SB-056: which storage backend is in force, and which source decided it.
//
// DC-002 ISOMORPHIC — this is `mirrorTarget()` (server/src/markdown.js) with a different
// value in it, deliberately so, right down to returning `{ …, source }` rather than a bare
// value. The banner names the winning source because SB-073 was a census run against four
// stale files by someone reading a banner that printed the env path while the stored setting
// quietly pointed somewhere else. Same failure is available here: an operator who set
// TT_BACKEND=vault and is looking at a mirror still being written needs the first line of the
// log to say `sqlite (backend setting)`, not to have to guess.
//
// Precedence, highest first:
//   env-locked  TT_BACKEND_LOCK is set → TT_BACKEND wins and the stored setting is IGNORED
//               (and rejected on write with a 403). This is the recovery path out of a wedged
//               install; see config.js.
//   setting     a stored `Settings.backend` → it wins over TT_BACKEND.
//   env         no stored setting, TT_BACKEND supplied one.
//   default     neither → `sqlite`, the repo default.
import TT from '../../shared/core.js';
import { BACKEND, BACKEND_FROM_ENV, BACKEND_LOCKED } from './config.js';
// Reads `db.js` DIRECTLY rather than the storage seam, and must keep doing so: `store.js`
// imports THIS module to decide which implementation to dispatch to, so going back through it
// would be a cycle. Which store is in use cannot itself be a question for the store.
import { getStoredBackend } from './db.js';

/** @typedef {import('../../shared/types.ts').Backend} Backend */
/** @typedef {{ backend: Backend, source: 'env-locked' | 'setting' | 'env' | 'default', shadowed: Backend | null }} BackendTarget */

/**
 * The effective backend and how it was decided. `shadowed` is the non-default TT_BACKEND the
 * stored setting beat, when there was one — the "your TT_BACKEND lost" line.
 * @returns {BackendTarget}
 */
export function backendTarget() {
  if (BACKEND_LOCKED) return { backend: BACKEND, source: 'env-locked', shadowed: null };
  // `getStoredBackend`, NOT `getSettings().backend`: the latter defaults to `sqlite`, which is
  // also a real choice, so nothing stored would be indistinguishable from stored-sqlite and
  // TT_BACKEND could never win. It also reads null for an unrecognised row, so a hand-edited
  // value falls through to the env rather than being trusted.
  const stored = getStoredBackend();
  if (!stored) return { backend: BACKEND, source: BACKEND_FROM_ENV ? 'env' : 'default', shadowed: null };
  return { backend: stored, source: 'setting', shadowed: BACKEND_FROM_ENV && stored !== BACKEND ? BACKEND : null };
}

/** The effective backend. @returns {Backend} */
export function activeBackend() {
  return backendTarget().backend;
}

/** What the effective backend is allowed to do. @returns {import('../../shared/types.ts').BackendCapabilities} */
export function activeCapabilities() {
  return TT.backendCapabilities(activeBackend());
}

/** Whether the backend is frozen by TT_BACKEND_LOCK (DC-002). @returns {boolean} */
export function backendLocked() {
  return BACKEND_LOCKED;
}
