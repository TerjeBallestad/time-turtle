// @ts-check
//
// ---- THE WRITER (SB-057) ----
//
// A save under `personal` writes daily notes. This is the module where TT first puts a byte into a
// real vault, and the two rules below are the ones that decide whether that is safe.
//
// ============================================================================================
// 1. THE WRITE SCOPE RULE (design decision 2) — the most dangerous thing in this ticket
// ============================================================================================
//
// A save may touch exactly:
//     {dates present in the incoming entry set}
//   ∪ {dates the index holds a `known` row for AND that had at least one entry before this save}
//
// NEVER a glob of the daily folder, and NEVER a date whose file TT has not confirmed reading.
//
// THE MECHANISM THAT MAKES IT LOAD-BEARING: `db.putEntries` is DELETE-all-then-insert, and the
// client PUTs its WHOLE entry set on every debounce. So a date TT lazily skipped — an evicted day,
// an unreadable one, one whose read timed out — is simply ABSENT from the PUT. A writer that read
// absence as "the day is now empty" would write a blank block over hours it had never even read.
// That is invariant 1 ("unreadable or absent → unknown, never empty") applied to the write side,
// and it is what makes `state = unknown` mean something instead of being a comment.
//
// The second clause is what still makes DELETION work: a date that HAD entries, whose file TT has
// confirmed reading, and which is now absent from the PUT, is a real deletion and its note is
// rewritten with an empty block. Deleted, not vanished — the note keeps its block and its anchor.
//
// AND THE "CONFIRMED READING" CLAUSE BINDS THE INCOMING SET TOO, which is stricter than the union
// reads on its own and is deliberate. `writeEligibility` below refuses a date whose note exists on
// disk but which TT has not arbitrated: TT would be splicing its block over rows it has never
// imported. The one exception is a note that is genuinely ABSENT — creating a file loses nothing,
// and it is how the first hour of a new day ever reaches the vault at all.
//
// ============================================================================================
// 2. THE WRITE FILTER — DD-016 + DD-017, via `TT.vaultBound`
// ============================================================================================
//
// A non-vault-bound entry goes to SQLite and never to a daily note, and never triggers DD-012
// adoption on its behalf. `TT.vaultBound` (shared/core.js) is the one home of the predicate; the
// hazards each clause closes are documented there. SKIPPED, never 403'd: `useServerSync` re-queues
// any non-409 failure and retries every 4 s forever, so a refusal on the save path is a permanent
// toast loop.
//
// ============================================================================================
// 3. DIFF BEFORE WRITING
// ============================================================================================
//
// Serialize the day, compare with what is on disk, and write nothing when they are equal. Without
// this, one keystroke rewrites every daily note the user has ever logged — a per-keystroke storm
// through iCloud, and the single thing most likely to make SB-046 come back "no". The skip count
// is logged, because that is the number to have in hand before that session.
//
// ============================================================================================
// 4. REFUSALS NEVER FAIL THE SAVE (SB-065's posture)
// ============================================================================================
//
// The SQLite write has COMMITTED by the time a byte is written here — `store.putEntries` queues
// this through `afterCommit` precisely so that is true, because it is not true of a bare call from
// inside the transaction. A note-level refusal is recorded on the index row and, when it is a
// refusal about the note's CONTENT, surfaced on Settings → Vault; it is never promoted to a 500,
// because "you cannot save at all" is a strictly worse failure than a note that has stopped
// syncing. Nothing in this module throws.
//
// AN I/O FAILURE IS RECORDED BUT NOT SURFACED, and the distinction is deliberate: a permissions
// error or a full disk is not a refusal about the block, and dressing it as a quarantine would send
// a human to look at a note that is perfectly fine. It sets the row to `unknown` (so no later save
// splices into a file TT has no current reading of) and logs. A surface for it is real work and is
// not smuggled in here.
import { join } from 'node:path';
import TT from '../../shared/core.js';
// db.js DIRECTLY — this module is INSIDE the storage seam, not a caller of it, and `store.js`
// dispatches to it. Same reason server/src/markdown.js does, spelled out at its own import site.
import * as db from './db.js';
import { activeShape } from './backend.js';
import { writeVaultFile } from './vault-fs.js';
import { fileSha } from './vault-arbitrate.js';
import { classifyVaultFile, noteOwnWrite, readNoteForWrite, vaultSyncConfig } from './vault-sync.js';

/** @typedef {import('../../shared/types.ts').Entry} Entry */
/** @typedef {import('../../shared/types.ts').VaultIndexRow} VaultIndexRow */

// ---- SB-068's seam (design decision 14) ----
/** @type {string | null} */
let lastCheckpointDay = null;
/** @type {(day: string) => void} */
let checkpointHook = () => {};
/**
 * SB-066 ruled that TT takes its own vault checkpoint — `git add -A` plus a `tt checkpoint: <ts>`
 * commit — before TT's first vault write of any calendar day, at most once per day. SB-068 filled
 * it in: `server/src/vault-checkpoint.js` is the implementation and `server/src/index.js` is the
 * one caller of this setter. The default stays a no-op, so the writer is correct with no hook at
 * all — which is what keeps every in-process test of this module free of a subprocess.
 *
 * THE TRIGGER IS THE WRITE PATH, NOT THE PROCESS LIFECYCLE, and that is the whole reason this hook
 * is here rather than at boot: `tt serve` spawns detached and `unref`'d (bin/tt.mjs:88-93), so a
 * per-boot hook on a server that runs for a fortnight would mean a per-FORTNIGHT checkpoint. That
 * is also why SB-068 is `blockedBy` this ticket.
 *
 * INSTALLING A HOOK CLEARS THE DAY GATE, because the new hook has taken no checkpoint — the gate
 * records what the CURRENT hook has already done, and carrying it across a re-point would mean a
 * newly-installed checkpoint silently skipping its first day. In production this is a distinction
 * without a difference (index.js calls this once, at module load, when the gate is already null);
 * it is what lets a test drive more than one checkpoint through the seam in one process.
 * @param {(day: string) => void} fn
 */
export function setVaultCheckpointHook(fn) {
  checkpointHook = typeof fn === 'function' ? fn : () => {};
  lastCheckpointDay = null;
}
/** Called immediately before the first `writeVaultFile` of a calendar day. Never throws. */
function checkpointIfFirstWriteOfDay() {
  const today = TT.todayStr();
  if (lastCheckpointDay === today) return;
  lastCheckpointDay = today;
  try {
    checkpointHook(today);
  } catch (err) {
    console.error('[time-turtle] vault checkpoint hook failed:', /** @type {Error} */ (err).message);
  }
}

/**
 * May TT write this date's note?
 *
 * `write` — the index holds a `known` row (TT has read it), or the file is genuinely absent
 *           (creating it loses nothing).
 * `quarantined` — TT has refused this note and must leave it exactly as it is.
 * `unread` — a file exists that TT has not confirmed reading: evicted, unreadable, a read that
 *           timed out, or one that appeared between scans. Not TT's to splice into yet. The entry
 *           is already safe in SQLite and the next scan claims the note.
 * @param {string} path @param {VaultIndexRow | null} row @returns {'write' | 'quarantined' | 'unread'}
 */
export function writeEligibility(path, row) {
  if (row && row.state === 'known') return 'write';
  if (row && row.state === 'quarantined') return 'quarantined';
  return classifyVaultFile(path).exists ? 'unread' : 'write';
}

/**
 * The dates one save may touch. See rule 1 in the header — this function IS that rule, and the
 * only reason it takes `before` is the deletion half of it.
 * @param {Entry[]} incoming the entry set just saved
 * @param {Entry[]} before the entry set as it was immediately before this save
 * @param {(date: string) => VaultIndexRow | null} indexFor
 * @returns {string[]} sorted, so a log line and a test read the same order
 */
export function writeScope(incoming, before, indexFor) {
  const dates = new Set();
  for (const entry of incoming || []) if (entry && entry.date) dates.add(entry.date);
  // The deletion half: a date that HAD entries and whose file TT has confirmed reading. A date
  // that is absent from the PUT and that TT has NOT confirmed reading is left alone — that is the
  // whole rule, and it is the difference between "the user deleted their morning" and "this
  // machine has never seen Tuesday".
  for (const entry of before || []) {
    if (!entry || !entry.date || dates.has(entry.date)) continue;
    const row = indexFor(entry.date);
    if (row && row.state === 'known') dates.add(entry.date);
  }
  return [...dates].sort();
}

/**
 * Write the vault side of a save. Never throws; every refusal is recorded and reported.
 *
 * @param {number} userId
 * @param {Entry[]} incoming the entry set just written to the index
 * @param {Entry[]} before the entry set as it was immediately before
 * @returns {{ written: string[], skipped: string[], refused: { date: string, reason: string }[] }}
 */
export function writeVaultEntries(userId, incoming, before) {
  /** @type {{ written: string[], skipped: string[], refused: { date: string, reason: string }[] }} */
  const report = { written: [], skipped: [], refused: [] };
  const config = vaultSyncConfig();
  if (!config) return report;
  const settings = db.getSettings();
  const context = { shape: activeShape(), vaultCutover: settings.vaultCutover, commits: db.getCommits(userId) };
  /** @param {string} date @returns {string} */
  const pathFor = (date) => join(config.dailyDir, date + '.md');
  /** @param {string} date @returns {VaultIndexRow | null} */
  const rowForDate = (date) => db.getVaultIndex(pathFor(date));

  // THE FILTER RUNS FIRST, and it decides two things at once: which entries may be written, and —
  // via the date set below — whether the day is touched at all. A day whose every entry is
  // pre-cutover or inside a committed segment is not "a day with no entries"; it is a day the
  // vault has no opinion about, and TT must not write an empty block over it.
  const bound = (incoming || []).filter((entry) => TT.vaultBound(entry, context));
  const boundBefore = (before || []).filter((entry) => TT.vaultBound(entry, context));
  const byDate = new Map();
  for (const entry of bound) {
    if (!byDate.has(entry.date)) byDate.set(entry.date, []);
    byDate.get(entry.date).push(entry);
  }

  for (const date of writeScope(bound, boundBefore, rowForDate)) {
    try {
      writeOneDate(date, byDate.get(date) || [], pathFor(date), config, report);
    } catch (err) {
      // Belt and braces on top of the per-step handling below. The SQLite write already committed;
      // a note that will not write is a note that has stopped syncing, never a failed save.
      const reason = /** @type {Error} */ (err).message;
      report.refused.push({ date, reason });
      console.error(`[time-turtle] vault write failed for ${date}: ${reason}`);
    }
  }
  if (report.skipped.length || report.written.length) {
    // THE SKIP COUNT. This is the number SB-046's latency session wants in hand: it says how many
    // notes a keystroke did NOT rewrite.
    console.log(
      `[time-turtle] vault write: ${report.written.length} written, ${report.skipped.length} unchanged${
        report.refused.length ? `, ${report.refused.length} refused` : ''
      }`,
    );
  }
  return report;
}

/**
 * Record what TT now knows about a path without disturbing what it already knew. One helper, so a
 * refusal cannot quietly forget the rev, the digest or the previous pair by omitting a field.
 * @param {string} path @param {string} date @param {VaultIndexRow | null} row
 * @param {Partial<VaultIndexRow>} over
 */
function keepRow(path, date, row, over) {
  db.putVaultIndex(
    /** @type {VaultIndexRow} */ ({
      path,
      date,
      state: 'unknown',
      rev: row ? row.rev : null,
      payloadDigest: row ? row.payloadDigest : null,
      fileSha: row ? row.fileSha : null,
      verified: row ? row.verified : null,
      quarantineReason: null,
      seenAt: new Date().toISOString(),
      writtenAt: row ? row.writtenAt : null,
      ...over,
    }),
  );
}

/**
 * One date. Read the note, splice TT's block into it, and write only if that changed anything.
 *
 * `revisionOverride` is what makes this the ONLY write path in this module. The arbitration's
 * `rev` is authoritative on the two verdicts that reach `rewriteVaultDate` — the file is known to
 * be wrong there, so re-deriving the counter from it would put the two in disagreement — and every
 * other caller derives it from the note. A second copy of this body is how the quarantine
 * recording, the `unread` gate and the checkpoint hook drift apart one fix at a time.
 * @param {string} date @param {Entry[]} entries @param {string} path
 * @param {NonNullable<ReturnType<typeof vaultSyncConfig>>} config
 * @param {{ written: string[], skipped: string[], refused: { date: string, reason: string }[] }} report
 * @param {number} [revisionOverride]
 */
function writeOneDate(date, entries, path, config, report, revisionOverride) {
  const row = db.getVaultIndex(path);
  const eligibility = writeEligibility(path, row);
  if (eligibility === 'quarantined') {
    report.refused.push({ date, reason: row && row.quarantineReason ? row.quarantineReason : 'quarantined' });
    return;
  }
  // A REWRITE IS EXEMPT FROM THE `unread` GATE, and only that gate. The arbitration has just read
  // this file and found it provably behind (or just imported it); "TT has not confirmed reading
  // this day" is the one thing that is definitely not true here, and refusing would leave a stale
  // peer standing forever. The quarantine gate above still applies.
  if (eligibility === 'unread' && revisionOverride == null) {
    // Recorded, not silently dropped: `unknown` is exactly what this is, and it is what the next
    // scan reads.
    keepRow(path, date, row, { state: 'unknown' });
    report.refused.push({ date, reason: 'unread' });
    return;
  }

  /** @type {string | null} */
  let current = null;
  try {
    current = readNoteForWrite(path);
  } catch (err) {
    // A NOTE TT CANNOT READ IS NOT A NOTE TT MAY STILL CLAIM TO KNOW. Leaving the row `known`
    // would let the next save splice into a file whose contents TT has no current reading of.
    // Recorded as `unknown` — the same verdict the scan gives an unreadable file, for the same
    // reason — and logged. NOT surfaced as a quarantine: a permissions error or a full disk is not
    // a refusal about the note's CONTENT, and dressing it as one would tell a human to go and look
    // at a block that is perfectly fine. Making an I/O failure visible in the UI is real work and
    // is deliberately not smuggled in here.
    keepRow(path, date, row, { state: 'unknown' });
    const reason = /** @type {Error} */ (err).message;
    report.refused.push({ date, reason });
    console.error(`[time-turtle] could not read ${path} to write it: ${reason}`);
    return;
  }
  const opts = {
    heading: config.heading,
    date,
    timeSeparator: config.timeSeparator,
    projects: config.projects,
  };
  // The revision TT is about to write. A located block's counter plus one; a note with no block
  // yet — brand new, or being adopted — starts at 1, which is what DD-012 says a first write does
  // and what `serializeVaultBlock`'s own default agrees with.
  const located = current == null ? null : TT.locateVaultBlock(current, opts);

  // DIFF BEFORE WRITING — and it has to run at the note's CURRENT revision, not at the bumped one.
  // Serializing at rev+1 first would make every save differ from the file by the counter alone, so
  // the diff would never fire and one keystroke really would rewrite every note the user has ever
  // logged. The counter moves only when something else moved.
  //
  // The comparison runs at the revision the write WOULD carry: the caller's override when there is
  // one, otherwise the note's own counter. Using the note's counter under an override would make
  // `import-and-rewrite` a no-op — the rows were just imported FROM this file, so at the file's own
  // revision the serialized result is the file, byte for byte, and the counter would never move.
  // The bump is the entire point of that verdict.
  if (current != null && located && !located.quarantine) {
    const wouldBe = revisionOverride != null ? revisionOverride : located.revision;
    const unchanged = TT.writeVaultBlock(current, entries, { ...opts, revision: wouldBe });
    if (!unchanged.quarantine && unchanged.md === current) {
      report.skipped.push(date);
      return;
    }
  }
  const revision =
    revisionOverride != null
      ? revisionOverride
      : (!located || located.quarantine ? (row && row.rev) || 0 : located.revision) + 1;

  /** @type {string} */
  let out;
  if (current == null) {
    // A day with no note at all. TT authors the whole file — just the block, because everything
    // else in a daily note is Terje's (or his Templater template's) and TT has no business
    // inventing an `## Intentions` for him.
    out = TT.serializeVaultBlock(entries, { ...opts, revision }) + '\n';
  } else {
    const written = TT.writeVaultBlock(current, entries, { ...opts, revision });
    if (written.quarantine) {
      // The note is NOT written and its row becomes `quarantined` with the reason. Left exactly as
      // it is for a human — SB-103 rules what they can then do about it. This applies on the
      // REWRITE path too, which is the path the arbitration reached BECAUSE something was already
      // wrong: a refusal there that left the row `known` would be invisible on the surface and
      // re-arbitrated every interval forever.
      keepRow(path, date, row, { state: 'quarantined', quarantineReason: written.reason });
      report.refused.push({ date, reason: String(written.reason) });
      return;
    }
    out = written.md;
  }

  // The belt to the diff's braces: an adoption or a first write can still come out identical to
  // what is there (a note whose block TT authored before the index existed), and that is not a
  // write either. Compared against the BYTES ON DISK, not against the index's sha, so a note whose
  // other sections changed externally is still recognised as needing no block write.
  if (current != null && out === current) {
    report.skipped.push(date);
    return;
  }

  checkpointIfFirstWriteOfDay();
  writeVaultFile(path, out);
  const sha = fileSha(out);
  const after = TT.locateVaultBlock(out, opts);
  const payloadDigest = after.quarantine ? null : after.digest;
  // The echo record, immediately after the write — with `rename()` the "after" is unambiguous.
  noteOwnWrite(path, sha, revision);
  const now = new Date().toISOString();
  db.putVaultIndex(
    /** @type {VaultIndexRow} */ ({
      path,
      date,
      state: 'known',
      rev: revision,
      payloadDigest,
      fileSha: sha,
      verified: true, // TT always writes a digest (DD-009); the digest-less shape is read-side only
      quarantineReason: null,
      seenAt: now,
      writtenAt: now,
    }),
  );
  report.written.push(date);
}

/**
 * The two arbitration verdicts that need a WRITE rather than an import — `import-and-rewrite` and
 * `rewrite-from-index`. Registered on the sync engine at boot (server/src/index.js), which is what
 * keeps the dependency running one way.
 *
 * It writes the INDEX's rows for that date, which is the point: for `rewrite-from-index` the file
 * is provably one revision behind and its rows are TT's own older ones, and for
 * `import-and-rewrite` the file's rows have just been imported, so the index is already current.
 * @param {number} userId @param {string} date @param {number} rev
 */
export function rewriteVaultDate(userId, date, rev) {
  const config = vaultSyncConfig();
  if (!config) return;
  const settings = db.getSettings();
  const context = { shape: activeShape(), vaultCutover: settings.vaultCutover, commits: db.getCommits(userId) };
  const entries = db.getEntries(userId).filter((entry) => entry.date === date && TT.vaultBound(entry, context));
  const path = join(config.dailyDir, date + '.md');
  /** @type {{ written: string[], skipped: string[], refused: { date: string, reason: string }[] }} */
  const report = { written: [], skipped: [], refused: [] };
  try {
    // `rev` comes from the arbitration and is the revision the FILE should end up at, so it is
    // passed as the override rather than re-derived: on this path the note is known to be wrong,
    // and deriving the counter from it would put the writer and the arbitration in disagreement.
    writeOneDate(date, entries, path, config, report, rev);
  } catch (err) {
    console.error(`[time-turtle] vault rewrite failed for ${date}: ${/** @type {Error} */ (err).message}`);
  }
  // Said out loud, because this path runs from a scan and not from a save — nobody is watching a
  // response for it, so silence here is a note that quietly stops being corrected.
  for (const refusal of report.refused)
    console.error(`[time-turtle] vault rewrite refused for ${refusal.date}: ${refusal.reason}`);
  if (report.written.length) console.log(`[time-turtle] vault rewrite: ${date} → revision ${rev}`);
}
