// @ts-check
import { writeFileSync, readFileSync, mkdirSync, renameSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import TT from '../../shared/core.js';
import { DATA_DIR, MD_DIR, MD_DIR_LOCKED, MD_DIR_FROM_ENV } from './config.js';
// SB-056: this module reads `db.js` DIRECTLY, not the storage seam, and that is deliberate.
// `writeMirror` only ever runs in the `team` shape — under `personal` the mirror is off
// entirely (DD-011) — so routing it through `store.js` would imply the mirror has a vault
// meaning it does not have. Under sqlite the two are the same tables anyway.
import {
  getSettings,
  getClients,
  getProjects,
  getTasks,
  getEntries,
  getCommits,
  listUsers,
  getMirrorSlug,
} from './db.js';

/** @typedef {{ dir: string, source: 'env-locked' | 'setting' | 'env' | 'default', shadowed: string | null }} MirrorTarget */
/** @typedef {import('../../shared/types.ts').MirrorBlock} MirrorBlock */
/** @typedef {{ hash: string, mtimeMs: number, size: number, writtenAt: string }} MirrorStamp */

// Where mirrors go, and which source won. Four ways to end up somewhere, and the loser
// is worth naming: a banner that printed MD_DIR while the stored setting quietly pointed
// at an Obsidian vault sent a census against four stale files (SB-073, from SB-069).
// `shadowed` is the non-default TT_MD_DIR the stored setting beat, when there was one.
/** @returns {MirrorTarget} */
export function mirrorTarget() {
  if (MD_DIR_LOCKED) return { dir: MD_DIR, source: 'env-locked', shadowed: null };
  const configuredDir = getSettings().mdDir?.trim();
  if (!configuredDir) return { dir: MD_DIR, source: MD_DIR_FROM_ENV ? 'env' : 'default', shadowed: null };
  const dir = resolve(configuredDir.startsWith('~') ? join(homedir(), configuredDir.slice(1)) : configuredDir);
  return { dir, source: 'setting', shadowed: MD_DIR_FROM_ENV && dir !== MD_DIR ? MD_DIR : null };
}

// The mdDir setting (editable in Settings → Markdown mirror, e.g. a cloud-synced
// Obsidian folder) wins over TT_MD_DIR / the default — unless TT_MD_DIR_LOCK froze it,
// in which case any stored setting is ignored (DC-002).
/** @returns {string} */
export function mirrorDir() {
  return mirrorTarget().dir;
}

// SB-088 found this: THE ONE TT.slug CALLER THAT READ AN EXISTING VALUE. The filename used to be
// re-derived from `user.name` on every write, so it was a function of a mutable field — rename
// the user and the next save writes a NEW file and silently abandons the old one, which stays on
// disk looking like a current timesheet.
//
// SB-112 pins it instead: `users.mirror_slug` is settled once, at creation, and never recomputed
// (server/src/db.js). That is what every other derived identifier here already does — client ids,
// `TT.projectCode`, task ids — and DC-005's rule that a rename is a deliberate, server-reconciled
// act rather than a silent re-derivation.
//
// NOTHING WAS MIGRATED AND NOTHING MOVED. The backfill seeds each existing row with exactly the
// slug this function used to compute, so every file stays where it is. No rename, no move, no
// delete — and because the paths are unchanged, every key already in the guard ledger stays a
// valid key, so `retireMirrors` still sweeps them on a backend switch. If a rename ever does fork
// a path (a hand-edited row, an unpinned user), the abandoned path is still a ledger key and is
// still swept; it is simply never written again.
//
// THE FALLBACK IS THE OLD BEHAVIOUR, ON PURPOSE. A row with no pinned slug keeps deriving from the
// name — i.e. keeps writing to the file it is writing to today. Defaulting to something "safer"
// like the id would move that user's mirror to a new filename on the next save, which is the exact
// harm this ticket is about.
/** Where one user's mirror file lives right now. @param {import('../../shared/types.ts').User} user */
export function mirrorPath(user) {
  const slug = getMirrorSlug(user.id) ?? TT.slug(user.name || user.email.split('@')[0]);
  return join(mirrorDir(), 'timesheet-' + slug + '.md');
}

// ---- SB-065: the never-clobber guard ----
//
// The mirror is write-only (DB → md, never md → DB), which was safe exactly as long as one
// machine owned the folder. Pointing `mdDir` at an iCloud-synced vault turned it into a
// shared mutable file with two writers, no merge, no lock and no last-writer detection —
// and on 2026-07-25 a single `PUT /api/state` replaced another machine's real dataset with
// this one's demo seed. There was no backup: obsidian-git had never committed the file.
//
// So: TT stamps every mirror file it writes (content hash + mtime + size) and re-reads the
// file before the next write. A hash mismatch — or NO STAMP AT ALL — means TT cannot prove
// it wrote what is there, so it refuses and records a sticky block. Same
// never-clobber-what-you-did-not-write posture already decided for the personal shape. This
// is NOT SB-008: no watcher, nothing is ever read back into the database, and the v2 mirror
// format is untouched (SB-069 froze it).
//
// Two shapes this deliberately takes:
//   * The refusal never fails the save. Callers catch MirrorBlockedError like any other
//     mirror failure and still answer 200 — the DB write has already committed, and turning
//     a mirror refusal into a 500 would mean the user cannot save at all. Worse failure.
//   * The refusal is sticky and reported by /api/state, not logged and forgotten. Quietly
//     ceasing to mirror leaves the file drifting while it still looks current — the exact
//     failure mode this guard exists to kill. It clears only when someone acknowledges it
//     (POST /api/mirror/acknowledge), which is consent to overwrite on the next write.
//
// State lives next to the database — the DB is per-machine and so is "what I last wrote" —
// in a plain JSON file rather than a table: no migration, and it stays readable and
// deletable by hand when someone has to unwedge a machine.
const GUARD_PATH = join(DATA_DIR, 'mirror-guard.json');

/** @typedef {{ version: number, files: Record<string, MirrorStamp>, blocked: Record<string, MirrorBlock> }} GuardState */

/** @returns {GuardState} */
function loadGuard() {
  try {
    const raw = JSON.parse(readFileSync(GUARD_PATH, 'utf8'));
    return { version: 1, files: raw.files ?? {}, blocked: raw.blocked ?? {} };
  } catch {
    // Missing or unreadable: start empty. Empty is the SAFE direction — every existing file
    // is then unstamped, so the guard refuses rather than assuming TT wrote it.
    return { version: 1, files: {}, blocked: {} };
  }
}

/** @param {GuardState} state */
function saveGuard(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = GUARD_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, GUARD_PATH);
}

/** @param {string} text @returns {string} */
function hashOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The file as it is on disk right now, or null if it isn't there. @param {string} path */
function inspect(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return { hash: hashOf(readFileSync(path, 'utf8')), mtimeMs: stat.mtimeMs, size: stat.size };
}

/** Thrown by writeMirror when the guard refuses. Carries the block so callers can report it. */
export class MirrorBlockedError extends Error {
  /** @param {MirrorBlock} block */
  constructor(block) {
    super(`mirror refused: ${block.reason} (${block.path})`);
    this.name = 'MirrorBlockedError';
    this.block = block;
  }
}

/** The sticky block on one path, if any. @param {string} path @returns {MirrorBlock | null} */
export function mirrorBlock(path) {
  return loadGuard().blocked[path] ?? null;
}

/**
 * The sticky block on a user's own mirror file, if any.
 * @param {import('../../shared/types.ts').User} user @returns {MirrorBlock | null}
 */
export function mirrorBlockFor(user) {
  return mirrorBlock(mirrorPath(user));
}

// "Yes, I dealt with it — overwrite." Clears the block; it does NOT write anything, so an
// acknowledgement made by mistake costs nothing until the user saves again.
//
// Clearing ADOPTS the file as it stands right now: the stamp is set to the bytes currently
// on disk, which is precisely the claim "I have seen this, TT may overwrite it". Merely
// deleting the block would deadlock — the very next write would find an unstamped file and
// refuse again. And if the file changes AGAIN between the acknowledgement and the write,
// the hash no longer matches the adopted one and the guard fires afresh. Correct: that is
// a second, unseen edit.
/** @param {string} path @returns {boolean} whether a block was actually cleared */
export function acknowledgeMirrorBlock(path) {
  const state = loadGuard();
  if (!state.blocked[path]) return false;
  delete state.blocked[path];
  const found = inspect(path);
  if (found) state.files[path] = { ...found, writtenAt: new Date().toISOString() };
  else delete state.files[path];
  saveGuard(state);
  return true;
}

// ---- SB-056 / DD-011: retiring the mirror files the toggle leaves behind ----
//
// Under `vault` the v2 `|`-mirror stops (see store.mirror). Stopping is only HALF of DD-011,
// and the half that was explicitly ruled out on its own: files frozen at the moment of
// cutover, sitting next to the daily notes in the same vault, still LOOKING current, is the
// stale-restore hazard SB-069 accepted risk on. So the toggle actively retires them.
//
// RENAME-ONLY, NEVER AN IN-PLACE REWRITE. This is the answer to the case SB-065's guard
// creates and this code has to get right ON PURPOSE: retiring a file TT is REFUSING to write.
// A rename loses no bytes, so it is safe on a file TT cannot prove it owns. A tombstone line —
// the other shape DD-011 permits — would be a write into exactly that file, which is the one
// thing the guard exists to forbid. THE RETIRED FILENAME IS THE TOMBSTONE. Nothing below ever
// opens a candidate for writing.
//
// THE SET COMES FROM THE GUARD LEDGER, NOT A GLOB: the keys of `files` (every path TT has
// written) UNION the keys of `blocked` (every path TT is refusing) UNION `mirrorPath(user)`
// for every current user under the CURRENT mirror dir. That is the record of what TT actually
// wrote, wherever it wrote it, so it survives `mdDir` having moved since — and it catches the
// demo-user files DD-011 asks to sweep without a `timesheet-*.md` glob that could rename a
// file a human made and TT never touched.
//
// WHY THE BLOCK IS CLEARED. Its purpose — do not destroy those bytes — is fully served by the
// rename. Worse, leaving it standing would WEDGE a later switch back to `sqlite`: writeMirror
// refuses a standing block forever (see the `standing` check below), so the first sqlite save
// after a round trip would throw against a file that is not even there any more.
/** @param {string} path @returns {string} the same path with `.md` stripped, if it had one */
function withoutMd(path) {
  return path.endsWith('.md') ? path.slice(0, -3) : path;
}

/**
 * THE CANDIDATE SET the block comment above argues for, named once (PLAN-013 / SB-115).
 *
 * EXTRACTED so the preflight and the sweep cannot drift: DD-018 has the preflight report which
 * mirror files a switch retires, and a second definition of "which files" is a rule that agrees
 * today and diverges on the first ruling. `retireMirrors` below consumes this and nothing else.
 *
 * Membership is NOT existence — a ledger key whose file is gone is still a candidate here (the
 * sweep needs it to clear the stale stamp). Callers that want "files a switch would actually
 * rename" filter by `existsSync` themselves; `retireMirrors` does it inline below.
 *
 * `guard` is a parameter so the sweep can pass the SAME snapshot whose keys it goes on to delete.
 * Re-loading it here would be a second `readFileSync` + `JSON.parse` on a path that runs on every
 * save via `store.mirror`, and would derive the set from a different read than the mutation.
 * @param {GuardState} [guard] @returns {Set<string>} absolute paths, unordered
 */
export function mirrorCandidates(guard = loadGuard()) {
  const candidates = new Set([...Object.keys(guard.files), ...Object.keys(guard.blocked)]);
  for (const user of listUsers()) candidates.add(mirrorPath(user));
  return candidates;
}

/**
 * Retire every mirror file TT wrote. Idempotent: a retired file is neither stamped nor any
 * user's mirror path, so it is never a candidate again and a second run renames nothing.
 * Never throws — a per-file failure is logged and that file keeps its stamp and its block.
 * @returns {{ from: string, to: string }[]} what was renamed, oldest-first
 */
export function retireMirrors() {
  const guard = loadGuard();
  const candidates = mirrorCandidates(guard);

  const stamp = new Date().toISOString().slice(0, 10);
  /** @type {{ from: string, to: string }[]} */
  const retired = [];
  let touched = false;
  for (const path of candidates) {
    if (existsSync(path)) {
      // `-2`, `-3` … on collision, so a second switch on the same day cannot overwrite the
      // first day's retirement. renameSync would happily clobber; that is the whole point.
      let to = `${withoutMd(path)}.retired-${stamp}.md`;
      for (let n = 2; existsSync(to); n++) to = `${withoutMd(path)}.retired-${stamp}-${n}.md`;
      try {
        renameSync(path, to);
      } catch (err) {
        // Keep the stamp AND the block: nothing moved, so nothing about this path is settled.
        console.error(`[time-turtle] could not retire ${path}: ${/** @type {Error} */ (err).message}`);
        continue;
      }
      retired.push({ from: path, to });
      console.log(`[time-turtle] retired mirror ${path} → ${to}`);
    }
    // Reached for a successful rename AND for a path that is already gone. A stamp for a file
    // that is not there says nothing, and a block on it is the wedge described above.
    if (guard.files[path] || guard.blocked[path]) {
      delete guard.files[path];
      delete guard.blocked[path];
      touched = true;
    }
  }
  // The ONE remaining way out of this function that is not a return. `saveGuard` does mkdirSync
  // + writeFileSync + renameSync, all of which throw on EACCES/ENOSPC/EROFS — and the boot call
  // site (server/src/index.js) is a bare top-level call, so an unguarded throw here would kill
  // the server at import with a stack trace instead of a sentence. The renames already happened
  // and are what matters; a stale stamp only costs one extra refusal on a later sqlite write.
  if (retired.length || touched) {
    try {
      saveGuard(guard);
    } catch (err) {
      console.error(
        `[time-turtle] retired ${retired.length} mirror file(s) but could not update the guard ledger: ${
          /** @type {Error} */ (err).message
        }`,
      );
    }
  }
  return retired;
}

// Mirror one user's timesheet (full catalog + their entries) to a markdown file.
// The file uses the app's round-trippable format — the whole thing can be pasted
// back into the app (admin) if the database is ever lost.
/** @param {import('../../shared/types.ts').User} user @returns {string} */
export function writeMirror(user) {
  const state = {
    settings: getSettings(),
    clients: getClients(),
    projects: getProjects(),
    tasks: getTasks(user.id),
    entries: getEntries(user.id),
    // SDD-002 ruling 4: the mirror carries the full commit ledger (frozen money and
    // all) so a mirror-restore keeps committed history; serializeMd only emits the
    // `## commits` section when it is non-empty.
    commits: getCommits(user.id),
  };
  const dir = mirrorDir();
  const path = mirrorPath(user);
  const content = TT.serializeMd(state);

  const guard = loadGuard();
  // Sticky: a recorded block keeps refusing until it is acknowledged, even if the file has
  // since been put back. Re-deciding here would let a sync round-trip silently un-block it.
  const standing = guard.blocked[path];
  if (standing) throw new MirrorBlockedError(standing);

  const found = inspect(path);
  if (found) {
    const stamp = guard.files[path];
    if (!stamp || stamp.hash !== found.hash) {
      // The bytes we were about to write are already there — an unchanged re-mirror, or a
      // file this machine wrote before the guard existed. Nothing can be lost by adopting
      // it, and refusing here would wedge every install on its first save after upgrade.
      if (found.hash === hashOf(content)) {
        guard.files[path] = { ...found, writtenAt: new Date().toISOString() };
        saveGuard(guard);
        return path;
      }
      /** @type {MirrorBlock} */
      const block = {
        path,
        detectedAt: new Date().toISOString(),
        reason: stamp
          ? 'the file changed on disk since Time Turtle last wrote it'
          : 'the file was not written by this Time Turtle',
        lastWrittenAt: stamp?.writtenAt ?? null,
      };
      guard.blocked[path] = block;
      saveGuard(guard);
      throw new MirrorBlockedError(block);
    }
  }

  mkdirSync(dir, { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  const after = inspect(path);
  if (after) guard.files[path] = { ...after, writtenAt: new Date().toISOString() };
  saveGuard(guard);
  return path;
}
