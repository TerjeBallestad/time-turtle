// @ts-check
import { writeFileSync, readFileSync, mkdirSync, renameSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import TT from '../../shared/core.js';
import { DATA_DIR, MD_DIR, MD_DIR_LOCKED, MD_DIR_FROM_ENV } from './config.js';
import { getSettings, getClients, getProjects, getTasks, getEntries, getCommits } from './db.js';

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

// The mdDir setting (editable in Settings → Markdown backend, e.g. a cloud-synced
// Obsidian folder) wins over TT_MD_DIR / the default — unless TT_MD_DIR_LOCK froze it,
// in which case any stored setting is ignored (DC-002).
/** @returns {string} */
export function mirrorDir() {
  return mirrorTarget().dir;
}

/** Where one user's mirror file lives right now. @param {import('../../shared/types.ts').User} user */
export function mirrorPath(user) {
  return join(mirrorDir(), 'timesheet-' + TT.slug(user.name || user.email.split('@')[0]) + '.md');
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
// never-clobber-what-you-did-not-write posture already decided for the vault backend. This
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
