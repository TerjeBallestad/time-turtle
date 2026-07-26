// @ts-check
// SB-056 / SB-100: which instance SHAPE is in force, which source decided it, and the storage
// backend that shape derives.
//
// DD-015 named the axis: an install chooses what it IS (`personal` | `team`), not which
// storage engine it runs. The backend (`vault` | `sqlite`) falls out of that and is never
// selected — so everything below resolves a SHAPE, and `activeBackend()` is a derivation on
// top of it, not a parallel setting.
//
// DC-002 ISOMORPHIC — this is `mirrorTarget()` (server/src/markdown.js) with a different
// value in it, deliberately so, right down to returning `{ …, source }` rather than a bare
// value. The banner names the winning source because SB-073 was a census run against four
// stale files by someone reading a banner that printed the env path while the stored setting
// quietly pointed somewhere else. Same failure is available here: an operator who set
// TT_SHAPE=personal and is looking at a mirror still being written needs the first line of the
// log to say `team (shape setting)`, not to have to guess.
//
// Precedence, highest first:
//   env-locked  TT_SHAPE_LOCK is set → TT_SHAPE wins and the stored setting is IGNORED
//               (and rejected on write with a 403). This is the recovery path out of a wedged
//               install; see config.js.
//   setting     a stored `Settings.shape` → it wins over TT_SHAPE.
//   env         no stored setting, TT_SHAPE supplied one.
//   default     neither → `team`, the repo default. This is the OPEN state, and it is the one
//               `source` value the boot-time inference rule (server/src/index.js) acts on: an
//               install that has answered the question — by env, by lock, or by a stored row —
//               is never re-answered underneath its operator.
import TT from '../../shared/core.js';
import { SHAPE, SHAPE_FROM_ENV, SHAPE_LOCKED } from './config.js';
// Reads `db.js` DIRECTLY rather than the storage seam, and must keep doing so: `store.js`
// imports THIS module to decide which implementation to dispatch to, so going back through it
// would be a cycle. Which store is in use cannot itself be a question for the store.
import { getStoredShape } from './db.js';

/** @typedef {import('../../shared/types.ts').Shape} Shape */
/** @typedef {import('../../shared/types.ts').Backend} Backend */
/**
 * @typedef {{
 *   shape: Shape,
 *   backend: Backend,
 *   source: 'env-locked' | 'setting' | 'env' | 'default',
 *   shadowed: Shape | null,
 * }} ShapeTarget
 */

/**
 * The effective shape, the backend it derives, and how it was decided. `shadowed` is the
 * non-default TT_SHAPE the stored setting beat, when there was one — the "your TT_SHAPE lost"
 * line.
 * @returns {ShapeTarget}
 */
export function shapeTarget() {
  /** @param {Shape} shape @param {ShapeTarget['source']} source @param {Shape | null} shadowed */
  const target = (shape, source, shadowed) => ({ shape, backend: TT.backendFor(shape), source, shadowed });
  if (SHAPE_LOCKED) return target(SHAPE, 'env-locked', null);
  // `getStoredShape`, NOT `getSettings().shape`: the latter defaults to `team`, which is also
  // a real choice, so nothing stored would be indistinguishable from stored-team and TT_SHAPE
  // could never win. Telling those two apart is also what makes the OPEN state a thing the
  // inference rule and SB-098's first-run question can see at all. It reads null for an
  // unrecognised row, so a hand-edited value falls through to the env rather than being trusted.
  const stored = getStoredShape();
  if (!stored) return target(SHAPE, SHAPE_FROM_ENV ? 'env' : 'default', null);
  return target(stored, 'setting', SHAPE_FROM_ENV && stored !== SHAPE ? SHAPE : null);
}

/** The effective shape. @returns {Shape} */
export function activeShape() {
  return shapeTarget().shape;
}

/**
 * The storage backend the effective shape DERIVES (DD-015). Never selected.
 *
 * DELIBERATELY UNCALLED TODAY, and that is not an oversight: nothing in the server branches on
 * the backend name any more — the guards branch on the SHAPE and the banner reads
 * `shapeTarget().backend`. Its first real caller is SB-057's vault store, which is the only
 * code that will ever need to know which implementation it is. Deleting it would only mean
 * re-deriving the same map somewhere worse.
 * @returns {Backend}
 */
export function activeBackend() {
  return shapeTarget().backend;
}

/** What the effective shape is allowed to do. @returns {import('../../shared/types.ts').ShapeCapabilities} */
export function activeCapabilities() {
  return TT.shapeCapabilities(activeShape());
}

/** Whether the shape is frozen by TT_SHAPE_LOCK (DC-002). @returns {boolean} */
export function shapeLocked() {
  return SHAPE_LOCKED;
}
