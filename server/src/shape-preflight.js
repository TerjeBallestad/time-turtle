// @ts-check
//
// ---- THE SHAPE-SWITCH PREFLIGHT (PLAN-013 / SB-115 / DD-018) ----
//
// One server-side answer to "what would this switch cost", computed BEFORE the gesture and
// mutating NOTHING. DD-018's ruling in one line: the numbers are computed, never asserted in
// prose — so the copy that says "214 entries" gets the 214 from here, and there is no second
// place where a number about a shape switch is invented.
//
// THREE WORDS, DD-018's rider to DD-015, and they are used exactly here:
//   * STRAND — what a switch does to entries the new shape will never carry. Nothing is moved,
//     copied or deleted; the entries stay in SQLite and stop reaching the vault. Not `migrate`,
//     not `archive`, and this module never writes a byte on their behalf.
//   * PREFLIGHT — this. Reads before, mutates never.
//   * RETIRE — DD-011's meaning, and it applies to MIRROR FILES ONLY. Never a daily note and
//     never a `## Time Log` block inside one. Nothing here touches a daily note.
//
// WHY IT IS A MODULE AND NOT A ROUTE BODY. The boot banner needs the same numbers with no HTTP
// in the room (`server/src/index.js` prints them when `TT_SHAPE=personal` switches an install
// with nobody present). Two computations of the same cost would disagree the first time either
// moves; this is the one.
//
// MUTATES NOTHING, and that is a property with a test rather than a comment: every file in the
// data dir is hashed before and after a call in tests/shape-preflight.test.js. The two ways to
// break it are both easy and both silent — `store.stampVaultCutover()` (it WRITES, see
// server/src/db.js) and `retireMirrors()` (it RENAMES) — so neither is called from this file.
import { existsSync } from 'node:fs';
import TT from '../../shared/core.js';
import * as db from './db.js';
import * as store from './store.js';
import { mirrorCandidates } from './markdown.js';

/**
 * THE CUTOVER THAT WOULD BE IN FORCE AFTER THE SWITCH — not necessarily the stored one.
 *
 * `stampVaultCutover` is first-stamp-wins (server/src/db.js): a value already there survives a
 * personal → team → personal round trip untouched, which is what keeps the team interlude's days
 * from being re-stranded. So the stored value wins whenever there IS one.
 *
 * On the common `team → personal` path nothing has ever been stamped — `getSettings().vaultCutover`
 * is `''` — and `TT.vaultBound` then excludes nothing by date at all, i.e. the preflight would
 * report zero stranded entries for a switch that is about to strand the whole back catalogue.
 * `now` is what the switch itself will stamp a moment later, so `now` is the honest answer.
 *
 * AND WE DO NOT STAMP IT. Calling `store.stampVaultCutover()` here would answer the question by
 * doing the thing — a preflight that mutated something is not a preflight.
 * @returns {string} an ISO instant
 */
function cutoverInForce() {
  return store.getSettings().vaultCutover || new Date().toISOString();
}

/**
 * WHAT SWITCHING THIS INSTALL TO `to` WOULD COST. Read-only in the strongest sense.
 *
 * `to === 'personal'` — what gets STRANDED:
 *   `{ to, entries: { count, first, last }, commits: { segments }, mirrors: string[], users: number }`
 *
 * @param {number} userId the CALLER's id — entry and commit counts are theirs and nobody else's
 * @param {string} to the TARGET shape, one of `TT.SHAPES`
 * @returns {Record<string, unknown>}
 */
export function shapePreflight(userId, to) {
  if (to === 'personal') return toPersonal(userId);
  // Deliberately loud rather than an empty object, so a shape with no preflight cannot quietly
  // start answering "nothing would happen". The route validates against TT.SHAPES first, so
  // this is reached only by a shape that is legal and unimplemented.
  throw new Error(`shapePreflight: no preflight for shape ${to}`);
}

/**
 * The `personal` direction. Everything the switch takes away.
 * @param {number} userId @returns {Record<string, unknown>}
 */
function toPersonal(userId) {
  const commits = store.getCommits(userId);
  // THE CONTEXT'S SHAPE IS THE TARGET, NEVER `activeShape()`. This is the single easiest thing
  // to get wrong here: the preflight is HYPOTHETICAL and is normally called from a `team`
  // install, where `TT.vaultBound` returns false for every entry on its first clause (only
  // `personal` has a vault at all) — so passing the live shape reports the entire timesheet as
  // stranded, on every call, and looks perfectly plausible doing it.
  const ctx = { shape: 'personal', vaultCutover: cutoverInForce(), commits };

  // STRANDED IS THE COMPLEMENT OF `TT.vaultBound`, and that predicate is not re-implemented
  // here. `shared/core.js` is its ONE home (its own header says so) and `server/src/vault-write.js`
  // already consumes it as the write filter. A second date comparison here would agree today and
  // disagree with the real filter on the first committed segment astride the cutover — DD-017's
  // ledger-wins-over-date clause is exactly the case a hand-rolled `entry.date < cutover` misses.
  const stranded = store.getEntries(userId).filter((entry) => !TT.vaultBound(entry, ctx));
  const dates = stranded.map((entry) => entry.date).sort();

  return {
    to: 'personal',
    entries: {
      count: stranded.length,
      // `null` and not `''` at zero: there is no first day of an empty set, and `''` is a date
      // the client would have to know to special-case.
      first: dates.length ? dates[0] : null,
      last: dates.length ? dates[dates.length - 1] : null,
    },
    // Every stored segment, unfiltered. DD-017 freezes a committed segment WHOLE under
    // `personal` — the ledger wins over the date — so there is no such thing as a segment that
    // only partly freezes, and nothing here to filter.
    commits: { segments: commits.length },
    mirrors: existingMirrors(mirrorCandidates()),
    users: db.listUsers().length,
  };
}

/**
 * The candidate paths that are really on disk, sorted.
 *
 * MECHANISM_DEVIATION declared by PLAN-013: DD-018 says "no vault read is required for any of
 * it", and this is one `existsSync` per candidate. `retireMirrors` only renames files that
 * EXIST, so an unfiltered list makes the modal say "4 files renamed" when 2 will be. The
 * guarantee actually being kept is that no note is opened, parsed or downloaded — SB-052
 * measured that `statSync` does not trigger an iCloud download (server/src/vault-fs.js), and a
 * dataless placeholder still stats as present, which is the safe direction to be wrong in.
 * @param {Set<string>} candidates @returns {string[]}
 */
function existingMirrors(candidates) {
  return [...candidates].filter((path) => existsSync(path)).sort();
}
