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
import { classifyVaultFile, importEntries, noteOwnWrite, readNoteForWrite, vaultSyncConfig } from './vault-sync.js';

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
 * Are these two notes the same note, ignoring table framing whitespace? THE SECOND CALL SITE of
 * `TT.normaliseVaultPayloadLine` (DD-023 half 2, SB-165) — the digest is the first.
 *
 * The skip test compares WHOLE NOTE TEXT rather than payload lines, so it cannot go through
 * `TT.vaultPayloadDigest`; it has to reach the same normaliser directly. TWO CALL SITES, ONE
 * DEFINITION. Normalise the digest and leave this comparing raw strings and TT rewrites the note
 * on every save just to restore its own padding — the per-keystroke iCloud write storm named at
 * the head of this file as the single thing most likely to make SB-046 come back "no". Trading a
 * quarantine for a write storm is not a fix.
 *
 * ONLY THE BLOCK REGION IS NORMALISED. Everything outside it is Terje's, and a table in his
 * `## Captures` is not TT's to have opinions about — normalising the whole note would let a
 * genuine change out there compare equal. The two sides are byte-identical outside the block by
 * construction today (the splice only replaces `start..end`), which is exactly the kind of
 * assumption that rots, so this does not rest on it.
 *
 * A side whose block will not locate falls back to raw equality: with no region there is nothing
 * to normalise, and answering "same" about a note TT cannot read would skip a write it owes.
 * @param {string} a @param {string} b
 * @param {{ heading?: string, date?: string, projects?: import('../../shared/types.ts').Project[] }} opts
 * @returns {boolean}
 */
function sameIgnoringTableFraming(a, b, opts) {
  // the note's LINES with the block region's normalised in place — an array, compared
  // element-wise, because joining the three slices back into one string would let a line break
  // land where a region boundary was and make two differently-split notes compare equal
  /** @param {string} text @returns {string[] | null} */
  const normalisedLines = (text) => {
    const loc = TT.locateVaultBlock(text, opts);
    if (loc.quarantine) return null;
    const lines = text.split('\n');
    for (let i = loc.start; i <= loc.end; i++) lines[i] = TT.normaliseVaultPayloadLine(lines[i]);
    return lines;
  };
  const left = normalisedLines(a);
  const right = normalisedLines(b);
  if (left == null || right == null) return a === b;
  return left.length === right.length && left.every((/** @type {string} */ line, /** @type {number} */ i) => line === right[i]); // prettier-ignore
}

/**
 * One date. Read the note, splice TT's block into it, and write only if that changed anything.
 *
 * `over.revision` is what makes this the ONLY write path in this module. The arbitration's `rev`
 * is authoritative on the two verdicts that reach `rewriteVaultDate` — the file is known to be
 * wrong there, so re-deriving the counter from it would put the two in disagreement — and every
 * other caller derives it from the note. A second copy of this body is how the quarantine
 * recording, the `unread` gate and the checkpoint hook drift apart one fix at a time.
 *
 * `over.adopt` (SB-127) is the one flag that reaches the CODEC rather than this function: it makes
 * `TT.locateVaultBlock` report a present-and-wrong digest as a digest-less block instead of
 * refusing, so DD-021's gesture can re-sign an anchor the writer would otherwise bounce. It rides
 * in the same options object as the revision because the two always travel together — an adopt
 * that did not also force `index.rev + 1` is DD-022 rider 2's silent undo — and `adoptVaultDate`
 * below is its ONLY caller. Everything else leaves it unset, which is DD-009 intact.
 * @param {string} date @param {Entry[]} entries @param {string} path
 * @param {NonNullable<ReturnType<typeof vaultSyncConfig>>} config
 * @param {{ written: string[], skipped: string[], refused: { date: string, reason: string }[] }} report
 * @param {{ revision?: number, adopt?: boolean }} [over]
 */
function writeOneDate(date, entries, path, config, report, over) {
  const revisionOverride = over && over.revision != null ? over.revision : null;
  const adopt = !!(over && over.adopt);
  const row = db.getVaultIndex(path);
  const eligibility = writeEligibility(path, row);
  // ADOPT IS THE ONE THING THAT PASSES THIS GATE, and only because the gate is what it is FOR:
  // `writeEligibility` says "TT has refused this note and must leave it exactly as it is", and a
  // human pressing "Adopt the note as-is" is precisely the authority that withdraws the refusal.
  // `adoptVaultDate` has already cleared the row off `quarantined` before calling, so in practice
  // this branch is not reached on the adopt path at all; the condition is here so that a row that
  // re-quarantined between the two steps cannot silently turn the gesture into a no-op.
  if (eligibility === 'quarantined' && !adopt) {
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
    // SB-127: threaded into EVERY codec call below, not just the splice. The locator runs three
    // times on this path (the revision probe, the diff's serialize-and-compare, and the splice's
    // own re-locate) and a flag set on some of them would make the three disagree about whether
    // the block is readable — which is how the diff would answer "unchanged" about a note the
    // splice then refused.
    adopt,
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
    if (!unchanged.quarantine && sameIgnoringTableFraming(unchanged.md, current, opts)) {
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
  //
  // RAW, not `sameIgnoringTableFraming` — deliberately, and it is not an oversight. The diff above
  // returns whenever the block located, so the only paths that reach here are ADOPTION and a note
  // with no block at all, where TT is inserting an anchor and a write is the point. A normalised
  // comparison here would only ever answer "same" for a block TT could not locate, which the
  // helper refuses to do anyway.
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
 *
 * SB-127 added `over` and the RETURN, for `adoptVaultDate`: the adopt gesture is the third caller
 * and the only one with a human waiting on a response, so it needs the refusal rather than a log
 * line. The two arbitration verdicts ignore both, exactly as before — nobody is watching them.
 *
 * `failed` IS THE THROW, RECORDED RATHER THAN ONLY LOGGED. `writeOneDate` reports every refusal it
 * DECIDES on, but an exception out of the filesystem is not a decision and left no trace in the
 * report at all — so a caller reading `refused` could not tell a write that failed from a write
 * that happened. It is the same log line as before plus a field the one waiting caller can read.
 * @param {number} userId @param {string} date @param {number} rev
 * @param {{ adopt?: boolean }} [over]
 * @returns {{ written: string[], skipped: string[], refused: { date: string, reason: string }[], failed: string | null } | undefined}
 */
export function rewriteVaultDate(userId, date, rev, over) {
  const config = vaultSyncConfig();
  if (!config) return;
  const entries = vaultBoundEntries(userId, date);
  const path = join(config.dailyDir, date + '.md');
  /** @type {{ written: string[], skipped: string[], refused: { date: string, reason: string }[], failed: string | null }} */
  const report = { written: [], skipped: [], refused: [], failed: null };
  try {
    // `rev` comes from the arbitration and is the revision the FILE should end up at, so it is
    // passed as the override rather than re-derived: on this path the note is known to be wrong,
    // and deriving the counter from it would put the writer and the arbitration in disagreement.
    writeOneDate(date, entries, path, config, report, { revision: rev, adopt: !!(over && over.adopt) });
  } catch (err) {
    report.failed = /** @type {Error} */ (err).message;
    console.error(`[time-turtle] vault rewrite failed for ${date}: ${report.failed}`);
  }
  // Said out loud, because this path runs from a scan and not from a save — nobody is watching a
  // response for it, so silence here is a note that quietly stops being corrected.
  for (const refusal of report.refused)
    console.error(`[time-turtle] vault rewrite refused for ${refusal.date}: ${refusal.reason}`);
  if (report.written.length) console.log(`[time-turtle] vault rewrite: ${date} → revision ${rev}`);
  return report;
}

/**
 * The entries a daily note for this date may carry — the index's rows for that day, through the
 * DD-016/DD-017 filter. Hoisted because SB-127's delta counts have to compare against EXACTLY the
 * set the writer would write, and a second `getEntries().filter(...)` spelled beside it is how
 * "TT holds 4" comes to mean a different four than the four that get written.
 * @param {number} userId @param {string} date @returns {Entry[]}
 */
function vaultBoundEntries(userId, date) {
  const settings = db.getSettings();
  const context = { shape: activeShape(), vaultCutover: settings.vaultCutover, commits: db.getCommits(userId) };
  return db.getEntries(userId).filter((entry) => entry.date === date && TT.vaultBound(entry, context));
}

/**
 * WHETHER the adopt gesture is on offer for this note, and what it would cost in rows — DD-021's
 * delta counts, computed server-side because only the server can read the note.
 *
 * IT ANSWERS BOTH QUESTIONS BECAUSE THEY ARE ONE QUESTION. `TT.vaultAdoptable(reason)` is
 * necessary and not sufficient: the reason says the refusal ADMITS the gesture, and only reading
 * the note says whether it can actually be performed. Every path below that cannot produce counts
 * is a path where `adoptVaultDate` refuses too — no config, the read threw, the note is gone, the
 * note no longer parses — so `adoptable: false` there is not a caution, it is the truth about what
 * pressing the button would do. That correspondence is the invariant: this function and
 * `adoptVaultDate` take the SAME admission test, one on the render and one on the click.
 *
 * SO THE CALLER GETS ONE ANSWER, NOT A FLAG BESIDE THREE MAYBE-NUMBERS. `VaultAdoptOffered` and
 * `VaultAdoptNotOffered` are a union for that reason (shared/types.ts): the surface cannot render
 * a control from a row that has no price, because there is no such value to render from. The
 * client used to read `dropped ?? 0` and turn an unpriced row into a free one-click adopt.
 *
 * WHAT COUNTS AS A MATCHING ROW: `TT.entryMatchKey`, the vault import's own row-identity function
 * (TERM-018, DD-008 rule 3's join over the fields a daily note can carry). Reused rather than
 * defined again here, which is the point — `preserveEntryIds` already answers "is this parsed row
 * the row the index holds?" on the import path, and a second answer to that question on the adopt
 * path is two definitions of the same word. It is deliberately blind to mode and the passthrough
 * columns, because the SQLite index has no column for either; see its own comment.
 *
 * `dropped` IS A MULTISET DIFFERENCE, TT MINUS NOTE — the rows TT holds that the note does not.
 * COUNTS ARE NOT THE TEST (DD-021 "drop **or change**", DD-022 rider 1): the same number of hours
 * logged differently is the ordinary restore, so `4 → 4` proves nothing on its own. Terje's live
 * case is one row on each side, `10:30→12:00` against `10:30→20:00`, and it must come back
 * `dropped: 1` — matching counts, one row lost, the confirm fires.
 *
 * Multiset, not set: two identical rows on one day are two rows, and adopting a note that has one
 * of them drops one. `preserveEntryIds` treats duplicates the same way, for the same reason.
 *
 * NOT OFFERED ON EVERY REASON THE GESTURE IS NOT ADMITTED ON. There the note does not parse (that
 * IS the refusal, on ten of the thirteen), so there is no second number to compare against — and a
 * lone "TT holds 4" beside a note nobody can act on is noise.
 * @param {number} userId @param {string} path @param {string} date @param {string | null} reason
 * @returns {import('../../shared/types.ts').VaultAdoptOffered | import('../../shared/types.ts').VaultAdoptNotOffered}
 */
export function vaultAdoptDelta(userId, path, date, reason) {
  /** @type {import('../../shared/types.ts').VaultAdoptNotOffered} */
  const none = { adoptable: false, ttEntries: null, noteEntries: null, dropped: null };
  const config = vaultSyncConfig();
  if (!config || !TT.vaultAdoptable(reason)) return none;
  /** @type {string | null} */
  let current;
  try {
    current = readNoteForWrite(path);
  } catch {
    // A note TT cannot READ cannot be adopted — `adoptVaultDate` returns the read error on the
    // same file — so the row is legible and carries no control rather than an unpriced one. Not
    // surfaced as an error of its own: a permissions blip on a synced folder is not a statement
    // about the note's CONTENT, and this runs on every `/api/state`.
    return none;
  }
  // Absent, likewise. `readNoteForWrite` answers null for ENOENT, and a note that is gone has no
  // rows — this is NOT the DD-012 empty-string case, which is about a day TT is creating.
  if (current == null) return none;
  const parsed = TT.parseVaultBlock(current, {
    heading: config.heading,
    date,
    projects: config.projects,
    // The same stand-down the adopt itself uses, and it has to be here too or the ONE reason
    // DD-021 was written for could never be counted — a `digest-mismatch` note refuses to parse
    // under the ordinary flag, which is exactly why it is quarantined.
    adopt: true,
  });
  if (parsed.quarantine) return none;
  const held = vaultBoundEntries(userId, date);
  /** @type {Map<string, number>} */
  const inNote = new Map();
  for (const entry of parsed.entries) {
    const key = TT.entryMatchKey({ .../** @type {any} */ (entry), date });
    inNote.set(key, (inNote.get(key) || 0) + 1);
  }
  let dropped = 0;
  for (const entry of held) {
    const key = TT.entryMatchKey(entry);
    const left = inNote.get(key) || 0;
    if (left > 0) inNote.set(key, left - 1);
    else dropped++;
  }
  return { adoptable: true, ttEntries: held.length, noteEntries: parsed.entries.length, dropped };
}

/**
 * DD-021's gesture, and DD-022's: the human has said this note is right. Take its rows into the
 * index, re-sign its anchor, and let the day sync again.
 *
 * ONE DIRECTION ONLY. Adopt means the NOTE's rows win and the index is rewritten from them —
 * under `vault` SQLite is the derived side (DD-006). There is no "keep TT's version" counterpart
 * and there is not going to be one: DD-021 killed it, DD-022 declined to reopen it, and
 * `rewrite-from-index` stays an arbitration verdict about a file TT can read and prove stale,
 * never a button on a file TT has refused. Do not grow this function a second direction.
 *
 * ADOPT IS NOT DESTRUCTIVE TO THE VAULT, which is why there is no checkpoint, no backup copy and
 * no rename-first here. The table already parses; TT re-emits the rows it just read and replaces
 * the revision line. The rows that go away go away from TT's INDEX, the derived side. Anyone
 * adding a ceremony to this write should read DD-021 first — it is refused there by name.
 *
 * THE ORDER MATTERS. Import first, then clear the quarantine, then write: the writer writes the
 * INDEX's rows for the date (that is what `rewriteVaultDate` does), so importing second would
 * write TT's old rows straight back over the note the human just adopted — the silent undo this
 * whole gesture exists to prevent, arriving through the gesture itself.
 * @param {number} userId @param {string} path @param {string} date
 * @returns {{ ok: boolean, error?: string, rev?: number, imported?: number }}
 */
export function adoptVaultDate(userId, path, date) {
  const config = vaultSyncConfig();
  if (!config) return { ok: false, error: 'no vault configured' };
  const row = db.getVaultIndex(path);
  if (!row || row.state !== 'quarantined') return { ok: false, error: 'that note is not paused' };
  if (!TT.vaultAdoptable(row.quarantineReason))
    return { ok: false, error: `a ${row.quarantineReason} refusal has no rows to adopt` };

  /** @type {string | null} */
  let current;
  try {
    current = readNoteForWrite(path);
  } catch (err) {
    return { ok: false, error: /** @type {Error} */ (err).message };
  }
  // There is nothing to adopt from a note that is no longer there — and creating one from TT's
  // index would be "keep TT's version" wearing the adopt button's label.
  if (current == null) return { ok: false, error: 'that note is no longer there' };
  const parsed = TT.parseVaultBlock(current, {
    heading: config.heading,
    date,
    projects: config.projects,
    adopt: true,
  });
  // The admission test is "TT can read the rows", and this is where it is actually taken rather
  // than inferred from the reason code. A row whose reason says adoptable but whose note will not
  // parse today — the bytes moved between the scan and the click — is refused, not guessed at.
  if (parsed.quarantine) return { ok: false, error: `the note no longer reads: ${parsed.reason}` };

  // THE COUNTER JUMPS AND NEVER REWINDS (DD-022 rider 2). Re-anchoring at the FILE's own revision
  // is the SB-061 failure this gesture exists to prevent: on a regression the file's counter is
  // behind the index's, so the peer machine's higher-rev copy would win the next arbitration and
  // silently undo the restore the human just accepted. `max` rather than `index.rev` alone so the
  // rule also holds the one time they are the other way round — a stale index row against a note
  // written on another machine — and so a row that has never recorded a revision (a note that
  // quarantined on TT's first ever sight of it) still lands somewhere sane. Accepted visible cost,
  // stated in the ruling: the number in the line Terje reads daily can jump.
  const rev = Math.max(row.rev == null ? 0 : row.rev, parsed.revision == null ? 0 : parsed.revision) + 1;

  importEntries(userId, date, parsed.entries);
  // Cleared BEFORE the write, because `writeEligibility` refuses a quarantined row and the whole
  // point of the gesture is that the refusal is withdrawn. `unknown` and not `known`: TT has not
  // written this file yet, and the write below is what earns the `known` row it ends on.
  db.putVaultIndex(
    /** @type {VaultIndexRow} */ ({
      ...row,
      state: 'unknown',
      quarantineReason: null,
      seenAt: new Date().toISOString(),
    }),
  );
  const report = rewriteVaultDate(userId, date, rev, { adopt: true });
  // SUCCESS IS "THE NOTE WAS WRITTEN", NOT "NOTHING WAS REFUSED". Gating on `refused` alone could
  // not see a write that THREW: an EACCES out of the atomic temp-write — the vault folder held for
  // a moment by a sync client, a full disk — leaves `refused` and `written` both empty, so the
  // gesture reported `ok` for a note it never touched. The anchor still carried the old digest, so
  // the day re-quarantined on the very next scan while the human had been told it was resolved.
  //
  // `written` IS A SOUND TEST AND `skipped` IS NOT A LEGITIMATE OUTCOME HERE. `rev` is
  // `max(index, file) + 1`, so it is always above the note's own counter, so the block TT
  // serializes always differs from the file by at least the revision line — neither the diff nor
  // the raw compare in `writeOneDate` can answer "unchanged" on this path. A skip means something
  // is wrong, and it must not read as a success.
  //
  // THE HALF THAT IS ALREADY DURABLE IS SAID OUT LOUD. Import-first is required (see THE ORDER
  // MATTERS above), so by the time a write can fail the note's rows are already in the index and
  // the quarantine is already cleared. What did not happen is the one thing the gesture exists to
  // do — re-sign the anchor — and the error says which half stands rather than implying neither.
  //
  // AND THE PAUSED ROW GOES BACK ON THE SURFACE. Clearing it first is forced, but leaving it
  // cleared after a write that did not happen takes the day OFF the screen at the moment a human
  // most needs it there: the note is still unwritten, still carries an anchor describing bytes
  // that are not in it, and the next scan re-quarantines it anyway — so the only thing the gap
  // buys is a stretch of time where the error message and the Settings surface disagree. Restored
  // to the row exactly as it stood, so a retry is the same press. Skipped when `writeOneDate`
  // recorded a quarantine of its OWN: that is a newer verdict about the same note, and putting the
  // old reason back over it would be this function overwriting a fresher reading with a stale one.
  if (!report || !report.written.includes(date)) {
    const after = db.getVaultIndex(path);
    if (!after || after.state !== 'quarantined') db.putVaultIndex(row);
    const why = report && report.refused.length ? report.refused[0].reason : report && report.failed;
    return {
      ok: false,
      error: `${why || 'the note was not written'} — the note’s rows are in the index, but the note itself was not rewritten`,
    };
  }
  console.log(`[time-turtle] vault adopt: ${date} → revision ${rev}, ${parsed.entries.length} rows from the note`);
  return { ok: true, rev, imported: parsed.entries.length };
}
