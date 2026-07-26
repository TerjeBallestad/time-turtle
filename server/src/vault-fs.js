// @ts-check
//
// ---- THE ONE WAY A BYTE GETS INTO THE VAULT (SB-064, folded into SB-057) ----
//
// `writeVaultFile(path, contents)` and nothing else. The "and nothing else" is the requirement;
// the function is only how it is kept.
//
// WHY IT HAS TO BE ATOMIC — three independent readers, none of them hypothetical:
//   • GIT. SB-066 ruled that TT takes its own vault checkpoint (`git add -A` + a `tt checkpoint:`
//     commit) before its first vault write of a calendar day, and SB-068 builds it. `git add`
//     during a non-atomic write stages a half-written note, so the backup is only ever as good as
//     the write primitive underneath it.
//   • OBSIDIAN'S FILE WATCHER, which will happily open the note mid-write and show a torn table —
//     and, worse, can diff-merge a torn read back over the real bytes (SB-051 measured exactly
//     that class of damage).
//   • ICLOUD'S UPLOADER, which propagates whatever it finds to the other machine, where a torn
//     intermediate becomes a permanently corrupt note nobody is watching.
//
// THE TEMP FILE LIVES IN THE SAME DIRECTORY AS ITS TARGET. `rename()` is atomic only WITHIN a
// filesystem; a temp in `/tmp` makes it a cross-device copy — which is precisely the torn write
// this primitive exists to prevent, arrived at by way of the fix for it.
//
// THE NAME IS `.tt-<basename>-<pid>-<counter>.tmp`, and both halves were measured on the real
// vault (PLAN-012 task 1, filed on SB-057), because the ticket's guess about them was half wrong:
//   • the `.tmp` EXTENSION is what keeps iCloud from taking the file. Four probes in one iCloud
//     folder: a plain `.md` and a DOT-PREFIXED `.md` were both uploaded (evictable) within 20 s;
//     a dot-prefixed `.tmp` and a plain `.tmp` were still refused (`NSFileProviderErrorDomain
//     -2008`) after five minutes. So the extension does all the anti-churn work.
//   • the DOT PREFIX is what keeps a stale temp out of sight — `ls`, Finder and Obsidian's file
//     explorer all hide it. It buys nothing against iCloud. Do not write that it does.
//   • `<pid>-<counter>` keeps two processes, and two writes inside one process, from colliding.
//
// AND `rename()` OVER AN EVICTED TARGET IS FREE. Measured the same day, against targets asserted
// `size > 0 && blocks === 0` immediately before the call: `renameSync` 0.3 ms, `writeFileSync`
// 785.9 ms (SB-052 measured 995 ms for the same thing on a different day). macOS materialises a
// dataless file before permitting a write and does not before permitting a rename, because a
// rename replaces a directory entry and never opens the old file. So this is a correctness fix
// that is also ~2600× faster on a cold machine.
import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** The prefix and suffix the sweep matches. One definition, so a name and its sweep cannot drift. */
const TEMP_PREFIX = '.tt-';
const TEMP_SUFFIX = '.tmp';
/** Distinguishes two writes inside one process; the pid distinguishes two processes. */
let counter = 0;

/** @param {string} path @returns {string} the temp path, always a sibling of `path` */
function tempFor(path) {
  return join(dirname(path), `${TEMP_PREFIX}${basename(path)}-${process.pid}-${++counter}${TEMP_SUFFIX}`);
}

/**
 * Half one: the temp exists, on disk, with the whole of `contents` in it. Nothing about the
 * TARGET has changed yet, and that is the invariant — a process that dies here has damaged
 * nothing.
 *
 * EXPORTED ONLY SO THE PROPERTY CAN BE PROVEN. The atomicity claim is "a process killed between
 * the write and the rename leaves the target wholly old", and the only honest way to test that is
 * to run this half in a child and SIGKILL it — a test that reimplemented the staging would be
 * proving something about the test. Every PRODUCTION caller uses `writeVaultFile`; if a second
 * one ever calls this directly, the file it half-writes is nobody's job to finish.
 *
 * `fsync` before the rename, not after: the rename is what publishes the file, so the bytes have
 * to be durable before the directory entry points at them, or a power loss can leave the target
 * pointing at an inode whose contents never reached the platter.
 * @param {string} path the FINAL path @param {string} contents @returns {string} the temp path
 */
export function stageVaultFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempFor(path);
  let fd = -1;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, contents, null, 'utf8');
    fsyncSync(fd);
  } catch (err) {
    // A failed write must not leave debris of its own. The unlink is best-effort: if the open
    // itself failed there is nothing to remove, and a failure to clean up must not replace the
    // real error with a misleading one.
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* already closed, or never opened */
      }
      fd = -1;
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing staged */
    }
    throw err;
  }
  closeSync(fd);
  return tmp;
}

/**
 * Half two: the swap. `rename()` is the atomic step — after it the target is wholly the new
 * contents, and before it the target is wholly the old ones. There is no in-between a reader can
 * observe.
 *
 * Then `fsync` on the CONTAINING DIRECTORY, which is the half people leave out: without it the
 * directory entry itself is not durable, so a power loss can lose the rename even though the
 * file's bytes were synced. Best-effort — a filesystem that refuses `fsync` on a directory fd has
 * still done the rename, and turning that into a failed save would be strictly worse than a
 * slightly less durable one.
 * @param {string} tmp @param {string} path
 */
export function commitVaultFile(tmp, path) {
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone already */
    }
    throw err;
  }
  let dirFd = -1;
  try {
    dirFd = openSync(dirname(path), 'r');
    fsyncSync(dirFd);
  } catch {
    /* the rename landed; directory durability is the bonus, not the guarantee */
  } finally {
    if (dirFd >= 0) {
      try {
        closeSync(dirFd);
      } catch {
        /* nothing to close */
      }
    }
  }
}

/**
 * Write a vault file atomically. THE ONLY function that puts a byte into the vault.
 *
 * Do NOT reroute `writeMirror` (server/src/markdown.js) through this. The v2 markdown mirror is a
 * capability of the SQLITE store (SB-056's ruling, DD-011) and only ever runs under the `team`
 * shape, where the file is not in a vault and its bytes are frozen (SB-069).
 * @param {string} path @param {string} contents @returns {string} the path written
 */
export function writeVaultFile(path, contents) {
  commitVaultFile(stageVaultFile(path, contents), path);
  return path;
}

/**
 * Remove stale temps left by a process that died between the write and the rename. Measured: a
 * SIGKILL really does leave one behind, and it stays forever otherwise.
 *
 * Matches on the prefix AND the suffix, so a real note called `.tt-something.md` is not a
 * candidate. Never throws: a sweep that cannot read the directory has nothing to say about
 * whether TT should start.
 *
 * It does not exempt this process's own temps, and does not need to: a write's staging window is
 * sub-millisecond, and under the `personal` shape there is exactly one user and one server
 * (DD-006 consequence 1) — there is no second TT staging a file while this one boots.
 * @param {string} dir @returns {string[]} the temps removed
 */
export function sweepVaultTemps(dir) {
  /** @type {string[]} */
  const swept = [];
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return swept; // no such directory yet, or unreadable — either way, nothing to sweep
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue;
    try {
      unlinkSync(join(dir, name));
      swept.push(name);
    } catch {
      /* another process got there first, or it is not ours to remove */
    }
  }
  return swept;
}
