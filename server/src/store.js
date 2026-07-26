// @ts-check
//
// ---- THE STORAGE SEAM (SB-056) ----
//
// Every TIMESHEET-STORAGE operation the API layer performs goes through this module, so that
// SB-057 can supply a second implementation (`backend: 'vault'`) without touching a single
// call site. Today there is exactly one implementation and this file is a straight re-export
// of `db.js`; that is deliberate, and the pure move is what lets the pre-existing api suite
// decide that a refactor of every storage call site changed no server behaviour.
//
// THE LINE, AND WHY IT IS DRAWN HERE
//
// IN  — settings, clients, projects, tasks, entries, commits, the DC-001 version counters,
//       the referential guards and reconciling renames, and `transaction`.
// OUT — IDENTITY. `findUserByEmail` / `findUserById` / `findUserWithHash` / `listUsers` /
//       `createUser` / `deleteUser` / `setUserPassword` / `getTokenVersion` / `seedIfEmpty`
//       stay on `db.js` and are called there DIRECTLY under BOTH backends.
//
// Identity is outside the seam because a vault has no user table — there is no file in an
// Obsidian vault that means "these are the accounts and these are their password hashes",
// and inventing one would be a security surface nobody asked for. What makes that correct
// rather than a compromise is DD-006 consequence 1: a vault belongs to ONE person, enforced
// by the single-user guard (Task 5 of PLAN-010 — refuse `vault` with >1 user, refuse a
// second user under `vault`, refuse to BOOT into the combination). Under `vault` the user
// table holds exactly one row, so keeping it in SQLite stores nothing the vault should own.
//
// So: do not "finish" this refactor by dragging `createUser` across. It is not an oversight.
//
// `server/src/markdown.js` likewise keeps importing `db.js` directly — see the reason at its
// import site. `writeMirror` only ever runs under `sqlite`.
//
// WHERE THE SECOND IMPLEMENTATION GOES: SB-057. Under `vault`, DD-006's own words are that
// SQLite becomes the DERIVED INDEX — so the catalog/entry operations below still resolve to
// these same tables, and SB-057 replaces their bodies behind these same names with the boot
// scan, hash index, watcher, revision arbitration, atomic writes and echo guard that keep
// that index in step with the vault files. `transaction` stays on the interface with the
// contract "atomic against the index"; what a vault write does inside one is SB-057's to
// define. That hole is NAMED, not forgotten.

import { activeCapabilities } from './backend.js';
import { writeMirror, retireMirrors } from './markdown.js';

export {
  // settings
  getSettings,
  putSettings,
  // catalog
  getClients,
  putClients,
  getProjects,
  putProjects,
  // per-user task templates (SDD-002)
  getTasks,
  putTasks,
  // entries
  getEntries,
  putEntries,
  // every user's entries, for the admin team report (server-side aggregation only)
  getAllEntries,
  // the per-user commit ledger (SDD-002 ruling 4)
  getCommits,
  putCommits,
  // DC-001 optimistic-concurrency counters
  getVersions,
  bumpCatalogVersion,
  bumpEntriesVersion,
  // SDD-002 ruling 7: the never-referenced true-delete guards
  projectCodeReferenced,
  clientReferenced,
  // DC-005 / SB-087: the server-reconciled renames — one transaction each, so nothing dangles
  renameProjectCode,
  renameClientId,
  // atomicity
  transaction,
} from './db.js';

// ---- the markdown mirror, as a CAPABILITY OF THE STORE (SB-056 / DD-011) ----
//
// Every mirror-writing call site in the API layer goes through here rather than calling
// `writeMirror` directly: `PUT /api/state`, the admin cross-user edit, approve/release, and
// both renames. That is what makes DD-011 correct BY CONSTRUCTION rather than by six
// remembered conditionals — under `vault` there is no branch anyone can forget, and
// re-pointing `mdDir` after the switch cannot resurrect a mirror write, because the rule is
// read off the BACKEND at call time and never off a path captured when the toggle flipped.
//
// It is on the store and not inside `writeMirror` for the same reason: a conditional inside
// `writeMirror` would make the mirror look like something the vault backend has an opinion
// about. It is not. It is something the SQLITE store does.
//
// Throws exactly what `writeMirror` throws (MirrorBlockedError and friends); every caller
// already catches and reports rather than failing the save (SB-065).
/** @param {import('../../shared/types.ts').User} user @returns {string | null} the path written, or null */
export function mirror(user) {
  if (!activeCapabilities().mirror) {
    // DD-011, both halves. Stopping is not enough on its own — frozen-but-current-looking is
    // the one option the ruling names and rejects — so every mirror call under `vault` also
    // RETIRES what is on disk. Running it from here (rather than once, at the switch) is what
    // makes DD-011's "the rule must hold against the setting moving" true: it re-resolves the
    // CURRENT mdDir every time, so re-pointing the folder after the switch retires there too.
    // Idempotent, and it never throws.
    retireMirrors();
    return null;
  }
  return writeMirror(user);
}
