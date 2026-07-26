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
import { mirrorCandidates, mirrorPath } from './markdown.js';

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
 * `to === 'team'` — what the way back WRITES:
 *   `{ to, vaultDays: { count, first, last }, mirrors: string[], users: number }`
 *
 * THE TWO PAYLOADS SHARE ONLY `to`, `mirrors` AND `users`, deliberately. Switching to `team`
 * strands nothing and freezes nothing, so there is no honest `entries` or `commits` to report —
 * and a key that means one thing in one direction and something else in the other is two terms
 * wearing one word.
 *
 * @param {number} userId the CALLER's id — entry and commit counts are theirs and nobody else's
 * @param {string} to the TARGET shape, one of `TT.SHAPES`
 * @returns {Record<string, unknown>}
 */
export function shapePreflight(userId, to) {
  if (to === 'personal') return toPersonal(userId);
  if (to === 'team') return toTeam();
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
 * The `team` direction — the way back, and DD-018's finding that forced its second ruling:
 * `writeMirror` writes the user's FULL timesheet, and under `personal` SQLite is the derived
 * index holding everything. So switching back does not RESUME a feature, it writes a fresh
 * `timesheet-<slug>.md` covering every day the `## Time Log` blocks already cover, into the same
 * vault — two markdown representations of the same hours. The numbers that sentence needs are
 * server-owned (DD-018 clause 6), so they come from here.
 *
 * MECHANISM_DEVIATION, declared in PLAN-013's setupNotes and requiring no human decision:
 * DD-018 specifies only the `personal` payload, and these numbers appear only inside SB-116's
 * modal mock. SB-115's own signature is `?to=personal|team`, so leaving this a 400 would make the
 * ticket's signature a lie and force SB-116 to grow the endpoint from the client side. Nothing
 * renders it yet, so SB-116 may reshape it — everything in it must still be true today.
 * @returns {Record<string, unknown>}
 */
function toTeam() {
  // `known` + `rev != null` is "TT HOLDS A BLOCK IN THIS NOTE" — the only state that licenses a
  // write (shared/types.ts: "`known` is the only state that licenses a write") and the only one
  // where a `## Time Log` block exists to stop updating.
  //
  // COUNTING EVERY ROW would silently promise TT maintains blocks in notes it could not even
  // read: `unknown` is a file TT failed to read, or a read that timed out, or a day left lazy
  // because it is iCloud-dataless; `quarantined` is one TT is actively refusing. Neither is a day
  // whose block stops updating, because neither is a day whose block TT was updating.
  //
  // This is TT's OWN record in SQLite. Nothing on disk is opened — DD-018's "no vault read".
  const dates = store
    .listVaultIndex()
    .filter((row) => row.state === 'known' && row.rev != null)
    .map((row) => row.date)
    .sort();

  const users = db.listUsers();
  return {
    to: 'team',
    // Simultaneously "days already written into your daily notes" and "`## Time Log` blocks that
    // stop updating" — SB-116's mock uses one number for both because it IS one set.
    vaultDays: {
      count: dates.length,
      first: dates.length ? dates[0] : null,
      last: dates.length ? dates[dates.length - 1] : null,
    },
    // `mirrors` KEEPS ONE MEANING ACROSS BOTH DIRECTIONS: the mirror files this switch acts on.
    // Under `personal` the switch retires them; under `team` it resumes writing them. The verb
    // belongs to the direction, the direction is already in `to`, and the client owns the verb.
    //
    // NOT existence-filtered here, and that is the difference rather than an oversight: this is a
    // claim about what the resumed mirror WILL write, and under `personal` those files have just
    // been retired, so filtering by existence would answer "no files" to "which files will
    // reappear". The `personal` direction filters because there the claim is about files a sweep
    // will really rename.
    mirrors: users.map(mirrorPath).sort(),
    users: users.length,
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
