// @ts-check
//
// ---- THE STORAGE SEAM (SB-056) ----
//
// Every TIMESHEET-STORAGE operation the API layer performs goes through this module, so that
// SB-057 can supply a second implementation (the `personal` shape's vault store) without touching a single
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
//       stay on `db.js` and are called there DIRECTLY under BOTH shapes.
//
// Identity is outside the seam because a vault has no user table — there is no file in an
// Obsidian vault that means "these are the accounts and these are their password hashes",
// and inventing one would be a security surface nobody asked for. What makes that correct
// rather than a compromise is DD-006 consequence 1: a vault belongs to ONE person, enforced
// by the single-user guard (Task 5 of PLAN-010 — refuse `personal` with >1 user, refuse a
// second user under `personal`, refuse to BOOT into the combination). Under `personal` the user
// table holds exactly one row, so keeping it in SQLite stores nothing the vault should own.
//
// So: do not "finish" this refactor by dragging `createUser` across. It is not an oversight.
//
// `server/src/markdown.js` likewise keeps importing `db.js` directly — see the reason at its
// import site. `writeMirror` only ever runs in the `team` shape.
//
// WHERE THE SECOND IMPLEMENTATION GOES: SB-057. Under `personal`, DD-006's own words are that
// SQLite becomes the DERIVED INDEX — so the catalog/entry operations below still resolve to
// these same tables, and SB-057 replaces their bodies behind these same names with the boot
// scan, hash index, watcher, revision arbitration, atomic writes and echo guard that keep
// that index in step with the vault files. `transaction` stays on the interface with the
// contract "atomic against the index"; what a vault write does inside one is SB-057's to
// define. That hole is NAMED, not forgotten.

import { activeCapabilities, activeBackend } from './backend.js';
import { writeMirror, retireMirrors } from './markdown.js';
import {
  getEntries as storedEntries,
  putEntries as putStoredEntries,
  afterCommit,
  putClients as putStoredClients,
  putProjects as putStoredProjects,
  putTasks as putStoredTasks,
  putSettings as putStoredSettings,
  renameProjectCode as renameStoredProjectCode,
  renameClientId as renameStoredClientId,
} from './db.js';
import TT from '../../shared/core.js';
import { writeVaultEntries, scheduleVaultCatalogWrite } from './vault-write.js';

export {
  // settings
  getSettings,
  getStoredShape,
  // SB-100 / DD-016: the cutover stamp. On the seam because SB-057's vault store is the thing
  // that will READ it — the write filter that keeps pre-cutover entries out of the vault.
  stampVaultCutover,
  // DD-024 clause 3: the demo seed, now a step the first-run answer can ask for rather than
  // something a boot does. On the seam for the same reason the stamp is — it writes the catalog
  // and entries through the store's own operations, so the vault implementation inherits it.
  seedDemoContent,
  // catalog. The PUT half of every one of these fans out to the catalog note — see below.
  getClients,
  getProjects,
  // per-user task templates (SDD-002)
  getTasks,
  // entries. `getEntries` stays a straight re-export under BOTH shapes: DD-006's "SQLite is the
  // derived index" is the architecture, so reading the index IS reading the vault, provided the
  // sync engine keeps it in step. A filesystem read on every GET /api/state would re-read 85 notes
  // to answer a request the index answers in a millisecond, and would make `getEntries` a call
  // that can fail. `putEntries` is the one that fans out — see below.
  getEntries,
  // every user's entries, for the admin team report (server-side aggregation only)
  getAllEntries,
  // the per-user commit ledger (SDD-002 ruling 4)
  getCommits,
  putCommits,
  // SB-057: the vault index — what TT last read from, and last wrote to, each daily note. On the
  // seam because it IS storage state: under `personal` it is the bookkeeping that keeps DD-006's
  // "SQLite is the derived index" honest, and this file's header names SB-057 as the ticket that
  // fills the hole. See the `vault_index` DDL in db.js for what it is and is not.
  getVaultIndex,
  getVaultIndexByDate,
  listVaultIndex,
  putVaultIndex,
  deleteVaultIndex,
  // DC-001 optimistic-concurrency counters
  getVersions,
  bumpCatalogVersion,
  bumpEntriesVersion,
  // SDD-002 ruling 7: the never-referenced true-delete guards
  projectCodeReferenced,
  clientReferenced,
  // atomicity
  transaction,
} from './db.js';

// ---- the per-date fan-out, the OTHER half of DD-006's derived index (SB-057) ----
//
// The seam this file's header named and left empty. Under `vault`, a save writes SQLite exactly as
// it always did — the index is still the read path — and THEN fans out to the daily notes the save
// is entitled to touch. Under `sqlite` this is byte-for-byte the old `db.putEntries` and there is
// no branch anyone can forget, which is the same argument `mirror` above makes for DD-011.
//
// THE `before` SNAPSHOT IS TAKEN HERE and nowhere else, because here is the last moment it exists:
// `db.putEntries` is DELETE-all-then-insert. The writer needs it for the deletion half of the
// write scope rule — "this date HAD entries, TT has read its file, and it is now absent from the
// PUT" is a real deletion, and it is only distinguishable from "TT has never seen Tuesday" while
// the old set is still readable.
//
// AND IT RUNS AFTER THE COMMIT, NOT INSIDE IT — `afterCommit`, not a bare call. This route is
// called from inside `store.transaction(...)` and the transaction CONTINUES afterwards, so a bare
// call would fsync daily notes (and, once SB-068 lands, take a git checkpoint over the whole vault)
// while nothing had committed. A throw later in the same transaction would then roll SQLite back
// and leave the vault describing entries the index no longer holds — the one direction DD-006's
// "SQLite is the derived index" cannot survive. See `afterCommit` in db.js for the full argument;
// outside a transaction it just runs.
//
// The fan-out never throws on its own account either (see vault-write.js): a note that will not
// write is a note that has stopped syncing, never a failed save. Same posture SB-065 chose for the
// mirror, which occupies exactly this position in the sequence for exactly this reason.
/** @param {number} userId @param {import('../../shared/types.ts').Entry[]} entries */
export function putEntries(userId, entries) {
  if (activeBackend() !== 'vault') {
    putStoredEntries(userId, entries);
    return;
  }
  const before = storedEntries(userId);
  putStoredEntries(userId, entries);
  afterCommit(() => writeVaultEntries(userId, entries, before));
}

// ---- the catalog fan-out (PLAN-017 task 2, DD-020) ----
//
// The same shape as the per-date fan-out above, one file over: under `vault` a catalog change
// writes SQLite exactly as it always did and THEN writes `Time Turtle.md`. Under `sqlite` these
// are byte-for-byte the old `db.*` functions and there is no branch anyone can forget — which is
// the argument this file already makes twice, for the mirror and for the daily notes.
//
// SIX CALL SITES, NOT ONE. Every way the catalog changes goes through here: the three tables, the
// settings, and the two server-reconciled renames. A rename that skipped this would move a project
// code in SQLite and leave the note naming the old one — a dangling reference in the file that
// resolves the rates, which is exactly what `catalog-dangling-client` refuses to import.
//
// THE WRITE IS COALESCED AND DEFERRED. One `PUT /api/state` can touch clients, projects, templates
// and settings inside one transaction, and they are all one note; `scheduleVaultCatalogWrite`
// queues one write for after the COMMIT. The reason it must not run inside the transaction is the
// one spelled out for `putEntries` above, and it is the serious one: a throw later in the same
// transaction rolls SQLite back while the note is already fsynced on disk.
//
// `mayCreate` IS PASSED, NEVER INFERRED (DD-020 c8). Creation is lazy — TT authors the note from
// the first write that NEEDS it — and "a person added a client" is not distinguishable from "the
// boot stored a shape" once you are inside the writer. A settings write carries the permission
// only when it actually carries a setting the note owns.
/** @param {import('../../shared/types.ts').Client[]} clients */
export function putClients(clients) {
  putStoredClients(clients);
  if (activeBackend() === 'vault') scheduleVaultCatalogWrite({ mayCreate: true });
}
/** @param {import('../../shared/types.ts').Project[]} projects */
export function putProjects(projects) {
  putStoredProjects(projects);
  if (activeBackend() === 'vault') scheduleVaultCatalogWrite({ mayCreate: true });
}
/** @param {number} userId @param {import('../../shared/types.ts').Task[]} tasks */
export function putTasks(userId, tasks) {
  putStoredTasks(userId, tasks);
  if (activeBackend() === 'vault') scheduleVaultCatalogWrite({ mayCreate: true });
}
/**
 * @param {Partial<Omit<import('../../shared/types.ts').Settings, 'vaultPaths'>> & { vaultPaths?: Partial<import('../../shared/types.ts').VaultPaths> }} settings
 */
export function putSettings(settings) {
  putStoredSettings(settings);
  if (activeBackend() !== 'vault') return;
  // A settings write may CREATE the note only when it carries a setting the note owns. Without
  // that gate, SB-100's boot-time shape inference — `putSettings({ shape: 'team' })`, run because
  // the process started — would materialise a file in somebody's vault.
  const owned = TT.VAULT_CATALOG_SETTING_KEYS.some(
    (key) => /** @type {Record<string, unknown>} */ (settings || {})[key] != null,
  );
  scheduleVaultCatalogWrite({ mayCreate: owned });
}
// Both renames RETURN, and the return is not decoration: the project rename hands back the user
// ids whose entries and templates it re-pointed (the routes mirror each of them), and the client
// rename hands back how many projects moved. A wrapper that swallowed either would leave the
// mirror silently un-rewritten for every affected user.
/** @param {string} from @param {string} to @returns {number[]} */
export function renameProjectCode(from, to) {
  const affected = renameStoredProjectCode(from, to);
  if (activeBackend() === 'vault') scheduleVaultCatalogWrite({ mayCreate: true });
  return affected;
}
/** @param {string} from @param {string} to @returns {number} */
export function renameClientId(from, to) {
  const moved = renameStoredClientId(from, to);
  if (activeBackend() === 'vault') scheduleVaultCatalogWrite({ mayCreate: true });
  return moved;
}

// ---- the markdown mirror, as a CAPABILITY OF THE STORE (SB-056 / DD-011) ----
//
// Every mirror-writing call site in the API layer goes through here rather than calling
// `writeMirror` directly: `PUT /api/state`, the admin cross-user edit, approve/release, and
// both renames. That is what makes DD-011 correct BY CONSTRUCTION rather than by six
// remembered conditionals — under `personal` there is no branch anyone can forget, and
// re-pointing `mdDir` after the switch cannot resurrect a mirror write, because the rule is
// read off the SHAPE at call time and never off a path captured when the toggle flipped.
//
// It is on the store and not inside `writeMirror` for the same reason: a conditional inside
// `writeMirror` would make the mirror look like something the personal shape has an opinion
// about. It is not. It is something the SQLITE store does.
//
// Throws exactly what `writeMirror` throws (MirrorBlockedError and friends); every caller
// already catches and reports rather than failing the save (SB-065).
/** @param {import('../../shared/types.ts').User} user @returns {string | null} the path written, or null */
export function mirror(user) {
  if (!activeCapabilities().mirror) {
    // DD-011, both halves. Stopping is not enough on its own — frozen-but-current-looking is
    // the one option the ruling names and rejects — so every mirror call under `personal` also
    // RETIRES what is on disk. Running it from here (rather than once, at the switch) is what
    // makes DD-011's "the rule must hold against the setting moving" true: it re-resolves the
    // CURRENT mdDir every time, so re-pointing the folder after the switch retires there too.
    // Idempotent, and it never throws.
    retireMirrors();
    return null;
  }
  return writeMirror(user);
}
