// @ts-check
//
// ---- THE VAULT CHECKPOINT (SB-066's ruling, SB-068's build) ----
//
// Terje's `vault backup: <ts>` commits are not a backup schedule. They are a PRE-FLIGHT CHECKPOINT
// taken by hand right before letting agents loose in the vault (SB-061). The ritual works because
// "letting agents loose" is discrete and attended: there is always an obvious before-moment.
//
// `tt serve` is the first vault writer with no such moment. It spawns detached and `unref`'d
// (bin/tt.mjs), writes every working day, and nobody is watching. So TT takes the checkpoint
// itself, and SB-066 ruled the shape:
//
//     Before TT's first vault write of any calendar day, `git add -A` + `git commit` the vault
//     root with the message `tt checkpoint: <ts>`. At most one per day.
//
// ============================================================================================
// THE FOUR THINGS THAT ARE NOT NEGOTIABLE
// ============================================================================================
//
// 1. IT NEVER BLOCKS A WRITE. A time tracker that will not record time is a strictly worse
//    failure than unprotected hours (SB-066, Terje's call). Vault is not a repo, git is not
//    installed, the commit errors, an `index.lock` is held, git hangs — every one of those is ONE
//    warning line and a `{ taken: false }`, never a throw and never a refusal. Nothing in this
//    module throws; that is the contract `vault-write.js` is written against, and it is belt to
//    the try/catch's braces there.
//
//    THE TIMEOUT IS PART OF THAT PROMISE, not a nicety. `spawnSync` with no timeout is an
//    unbounded wait on a subprocess, and a `git commit` CAN block indefinitely — a pinentry
//    prompt for a signing key, a credential helper, a filesystem stall. That would hold up the
//    user's save behind a backup. Hence the bound below, plus `--no-gpg-sign` (nothing should
//    ever ask for a passphrase to take a machine checkpoint) and `--no-verify` (a pre-commit hook
//    is somebody else's program and it must not get a vote on whether TT can write).
//
// 2. THE MESSAGE PREFIX IS THE WHOLE MITIGATION. TT becomes the majority author of the vault's
//    safety history — ~220 TT commits/yr against Terje's ~0.32/day, so ~4:1 within a year. The
//    accepted cost is only acceptable because `tt checkpoint:` and `vault backup:` are filterable,
//    which keeps his ATTENDED commits findable. Do not "tidy" this prefix, and do not reuse his.
//
// 3. `add -A`, THE WHOLE WORKTREE — not just `Calendar/Daily/*`. A checkpoint of TT's own paths is
//    not a checkpoint of the vault: a restore would leave everything else at whatever the last
//    `vault backup:` caught, possibly months back. The vault's `.gitignore` already excludes
//    `Attachments/`, `Apple Notes/`, `Notion/`; the worst case is committing a half-typed note,
//    which is harmless in a local-only repo with no remote (SB-061 measured: no remote at all).
//    EXPECT THE FIRST COMMIT TO BE FAT — it adopts whatever is currently untracked, including
//    TT's legacy `Inbox/timesheet-*.md` mirrors. Expected, documented on SB-068, not a bug.
//
// 4. NOTHING TO COMMIT → NO EMPTY COMMIT, AND THE DAY STILL COUNTS. An empty commit is noise in
//    the one history whose job is to make TT's changes visible. The day-counting is the CALLER's
//    (`vault-write.js` marks the day before calling), which is why a `{ taken: false, reason:
//    'clean' }` here is a success and not a retry.
//
// ============================================================================================
// WHY THE `git log` PROBE EXISTS — the cross-process half of "at most once per day"
// ============================================================================================
//
// The caller's day gate (`lastCheckpointDay` in vault-write.js) is PER-PROCESS. Three `tt serve`
// restarts in one day are three processes, each with a null gate, and without the probe that is
// three checkpoints in a day. So the last `tt checkpoint:` commit is READ BACK and its own stamped
// day compared with today.
//
// It is compared against the day in the MESSAGE, not against the commit's author/committer date.
// The message carries the day TT itself decided it was — the same `TT.todayStr()` the write path
// used — so the two halves of the rule cannot disagree about where midnight is, and a test can
// simulate tomorrow without simulating a clock.
//
// The one gap, stated rather than hidden: if today's checkpoint found a clean vault, no commit
// exists to find, and a restart later that day (with the vault now dirty) takes one. That is a
// second checkpoint on a day the rule allows one — and it is the harmless direction, since the
// only thing that "extra" commit does is capture state that genuinely had no checkpoint behind it.
import { spawnSync } from 'node:child_process';

/** SB-066: deliberately NOT `vault backup:` — see note 2 above. Trailing space included. */
export const CHECKPOINT_PREFIX = 'tt checkpoint: ';
/** The bound on every git call. See note 1: this is what makes "never blocks" true of a hang. */
const GIT_TIMEOUT_MS = 20_000;

/**
 * One git invocation, and the only place a subprocess is spawned. Never throws: `spawnSync`
 * reports a missing binary and a timeout on the returned object rather than by raising, and
 * that is exactly the shape this module wants.
 * @param {string} root @param {string[]} args
 * @returns {{ ok: boolean, out: string, err: string }}
 */
function git(root, args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024, // a `status --porcelain` over a fat first checkpoint is long
  });
  // ONE LINE. `git add` failing on a lock writes a six-line essay to stderr, and SB-066's ruling
  // is one warning line — a daily multi-line rant in `tt-serve.log` is how a log stops being read.
  // Flattened rather than truncated: every word of that essay is the diagnosis.
  const flat = (/** @type {string} */ s) => s.trim().replace(/\s*\n\s*/g, ' ');
  if (r.error) return { ok: false, out: '', err: flat(/** @type {Error} */ (r.error).message) };
  return {
    ok: r.status === 0,
    out: (r.stdout || '').trim(),
    err: flat(r.stderr || '') || (r.status === null ? 'git was killed (timed out)' : `git exited ${r.status}`),
  };
}

/** `<day> HH:MM:SS`, local — the same shape as Terje's `vault backup:` stamps, differing only in
 * the prefix. The DAY half is the caller's day, not `now`'s, so the message and the day gate
 * cannot disagree; see the `git log` probe note above.
 * @param {string} day @param {Date} [now] @returns {string} */
export function checkpointStamp(day, now = new Date()) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${day} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

/**
 * The day of the most recent `tt checkpoint:` commit on HEAD, or null.
 *
 * A FAILING PROBE READS AS "NONE", deliberately: in a repo with no commits yet `git log` exits
 * 128, and that is the ordinary first-ever-checkpoint case rather than an error. The cost of
 * being wrong here is one extra commit on a day that already had one, which harms nothing; the
 * cost of treating it as fatal would be a vault that never gets checkpointed at all.
 * @param {string} root @returns {string | null}
 */
export function lastCheckpointDayInRepo(root) {
  const r = git(root, ['log', '-1', `--grep=^${CHECKPOINT_PREFIX}`, '--format=%s']);
  if (!r.ok || !r.out) return null;
  const m = new RegExp(`^${CHECKPOINT_PREFIX}(\\d{4}-\\d{2}-\\d{2})`).exec(r.out);
  return m ? m[1] : null;
}

/**
 * Take the day's checkpoint. Called at most once per calendar day per process, immediately before
 * TT's first vault write of that day.
 *
 * NEVER THROWS, NEVER BLOCKS THE WRITE — every branch returns. See note 1.
 *
 * @param {string} root the vault ROOT (not the daily folder — a checkpoint of `Calendar/Daily` is
 *   not a checkpoint of the vault)
 * @param {string} day `YYYY-MM-DD`, the day the write path believes it is
 * @param {{ log?: (msg: string) => void, warn?: (msg: string) => void, now?: Date }} [io]
 * @returns {{ taken: boolean, reason: 'committed' | 'clean' | 'already-checkpointed' | 'no-repo' | 'add-failed' | 'status-failed' | 'commit-failed' | 'no-root', sha?: string }}
 */
export function vaultCheckpoint(root, day, io = {}) {
  const log = io.log || ((/** @type {string} */ m) => console.log(m));
  const warn = io.warn || ((/** @type {string} */ m) => console.error(m));
  if (!root) return { taken: false, reason: 'no-root' };

  // Is there a repo here at all? `--is-inside-work-tree` and not `--git-dir`, because a bare repo
  // has a git dir and no worktree to `add -A`, and a vault is never bare. This branch also catches
  // git missing entirely (ENOENT from the spawn) and an unreadable root — one message for all
  // three, because the operator's next move is the same: look at the vault.
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    warn(`[time-turtle] vault checkpoint skipped: ${root} is not a git worktree (${inside.err}) — writing anyway`);
    return { taken: false, reason: 'no-repo' };
  }

  // The cross-process half of at-most-once-per-day. Silent when it fires: a restart finding the
  // day already checkpointed is the rule working, not a problem to report.
  if (lastCheckpointDayInRepo(root) === day) return { taken: false, reason: 'already-checkpointed' };

  const added = git(root, ['add', '-A']);
  if (!added.ok) {
    warn(`[time-turtle] vault checkpoint failed at git add: ${added.err} — writing anyway`);
    return { taken: false, reason: 'add-failed' };
  }

  // Nothing staged → no empty commit (note 4). Asked AFTER the add, so it is a question about the
  // index TT is about to commit and not about the worktree TT was about to stage.
  const status = git(root, ['status', '--porcelain']);
  if (!status.ok) {
    warn(`[time-turtle] vault checkpoint failed at git status: ${status.err} — writing anyway`);
    return { taken: false, reason: 'status-failed' };
  }
  if (!status.out) return { taken: false, reason: 'clean' };

  const message = CHECKPOINT_PREFIX + checkpointStamp(day, io.now);
  const committed = git(root, ['commit', '--no-verify', '--no-gpg-sign', '-m', message]);
  if (!committed.ok) {
    warn(`[time-turtle] vault checkpoint failed at git commit: ${committed.err} — writing anyway`);
    return { taken: false, reason: 'commit-failed' };
  }
  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  log(`[time-turtle] vault checkpoint: ${message}${head.ok ? ` (${head.out})` : ''}`);
  return { taken: true, reason: 'committed', sha: head.ok ? head.out : undefined };
}
