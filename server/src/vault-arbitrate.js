// @ts-check
//
// ---- THE ARBITRATION MATRIX (SB-057) ----
//
// One pure function. No filesystem, no database, no clock — it is handed what TT read from a file
// and what the index holds, and it returns a verdict. The purity is the requirement, not a style
// preference: it is what lets every row below be a table-driven test case, and what lets the
// fs-shaped machinery around it (server/src/vault-sync.js) stay thin enough to read.
//
// THE TABLE, in the order the checks run:
//
//   file unchanged (file_sha matches the index)              → skip
//   unreadable / absent / the read timed out                 → unknown   (NEVER "empty")
//   the parse quarantined                                    → quarantine, carrying the reason
//   the note was ADOPTED (DD-012)                            → import
//   no index row at all, and the block parses                → import
//   file.rev  >  index.rev                                   → import              (the other machine wrote it)
//   file.rev === index.rev, digest matches                   → skip
//   file.rev === index.rev, digest differs, verified         → import-and-rewrite at rev+1
//   file.rev === index.rev, digest differs, NOT verified     → import as unverified
//   file.rev  <  index.rev, matches the recorded previous    → rewrite-from-index  (the peer is behind)
//   file.rev  <  index.rev, TT recorded that rev, differs    → quarantine  external-rewrite
//   file.rev  <  index.rev, TT has NO record of that rev     → quarantine  unprovable-staleness
//
// THE LAST THREE ARE WHY THIS TICKET EXISTS, and the third of them is the one an implementer gets
// wrong. SB-061's case is a DELIBERATE `git restore` of a daily note: the vault's checkpoint
// history exists so a human can undo TT, and a writer that "helpfully" rewrites any lower revision
// from its index silently undoes the one recovery gesture that history is for. So TT rewrites only
// when it can PROVE the peer is stale — the file's revision is the one TT recorded as previous AND
// its payload is byte-for-byte the payload TT recorded at that revision. Anything else quarantines,
// including (especially) the case where the regression is more than one revision back or the index
// was rebuilt and TT simply has no record. Defaulting to "rewrite" when staleness cannot be proven
// is exactly the failure that was filed.
//
// `digest-mismatch` IS NOT A ROW HERE (DD-009 / design decision 6). `TT.locateVaultBlock` refuses a
// present-and-wrong digest before the parser runs, and `TT.writeVaultBlock` re-locates so it is
// refused on the write side too. It arrives here as an ordinary `quarantine` carrying that reason,
// and this function's job is to route it to surfacing — not to re-decide something already decided.
//
// AND A RUNNING ROW IS NOT A SPECIAL CASE (design decision 16). `17:34→` hashes, arbitrates and
// round-trips as ordinary content; there is no `if` for it anywhere below, deliberately. What a
// running timer MEANS across two machines is SB-050's to rule, and settling it by writing a branch
// here would be ruling it by accident. Two test cases pin that this stays true.

import { createHash } from 'node:crypto';
import TT from '../../shared/core.js';

/** @typedef {import('../../shared/types.ts').VaultIndexRow} VaultIndexRow */
/** @typedef {import('../../shared/types.ts').VaultArbitrationVerdict} VaultArbitrationVerdict */
/** @typedef {import('../../shared/types.ts').VaultArbitrationInput} VaultArbitrationInput */

/**
 * The whole-file hash — "did this file change AT ALL". sha256 via `node:crypto`, server-side only.
 *
 * NOT the arbitration input, and the two must never be collapsed (design decision 3): this one
 * moves when Terje edits `## Captures`, which must not read as a block change, and the arbitration
 * hash has to be the one the anchor carries or the rev-regression split compares against a number
 * no note ever contained.
 * @param {string} text @returns {string}
 */
export function fileSha(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Turn a note's TEXT into what `arbitrate` needs to see. Pure — bytes in, verdict input out — so
 * the sync engine's only job is getting the bytes, and this suite can drive the real composition
 * rather than a hand-built imitation of it.
 *
 * THE PAYLOAD DIGEST IS TAKEN THROUGH THE LOCATOR, not recomputed from the parse: the locator is
 * what knows which lines are the payload (header + delimiter + data rows, DD-009 consequence 1),
 * and `TT.vaultPayloadDigest` is what turns them into the anchor's own hash. For a verified block
 * this is by construction the digest printed in the anchor; for a digest-less one it is what the
 * anchor would have carried. A block the locator refuses has no payload digest, which is correct —
 * there is nothing TT is willing to describe.
 * @param {string} text
 * @param {{ heading?: string, date?: string, projects?: import('../../shared/types.ts').Project[] }} [opts]
 * @returns {NonNullable<VaultArbitrationInput['file']>}
 */
export function describeVaultFile(text, opts) {
  const loc = TT.locateVaultBlock(text, opts);
  /** @type {string | null} */
  let payloadDigest = null;
  if (!loc.quarantine) {
    const lines = text.split('\n');
    payloadDigest = TT.vaultPayloadDigest(
      [lines[loc.headerLine], lines[loc.separatorLine]].concat(loc.rowLines.map((ln) => lines[ln])),
    );
  }
  return { readable: true, sha: fileSha(text), payloadDigest, parse: TT.parseVaultBlock(text, opts) };
}

/**
 * Decide what to do about one daily note.
 *
 * `file.payloadDigest` is `TT.vaultPayloadDigest` over the block's payload lines — the SAME hash
 * the bottom anchor carries (design decision 3). The caller computes it because this function is
 * handed a PARSE and not a note; for a verified block it is by definition the anchor's own digest,
 * and for a digest-less one it is what the anchor would have carried. It must never be the
 * whole-file sha: that one moves when Terje edits `## Captures`, and comparing it against a
 * recorded payload digest would compare against a number no note ever contained.
 *
 * @param {VaultArbitrationInput} input
 * @returns {VaultArbitrationVerdict}
 */
export function arbitrate({ file, index }) {
  // 1. THE CHEAP EXIT, first because it is what makes the slow interval scan free on a quiet day.
  //    A `file_sha` match means the bytes have not moved AT ALL — including a file whose index row
  //    is `quarantined`, which stays quarantined and stays visible, because nothing about it
  //    changed. Guarded on the sha being present: an unreadable file has none, and `null === null`
  //    would otherwise read as "unchanged" for two files TT never saw.
  if (file && file.sha != null && index && index.fileSha != null && index.fileSha === file.sha) {
    return { verdict: 'skip' };
  }

  // 2. UNREADABLE, ABSENT, OR TIMED OUT → `unknown`. Invariant 1, and the word matters: `unknown`
  //    is not `empty`. TT never infers a deletion from a file it could not read, because the write
  //    scope rule (design decision 2) then treats the day as one it may not touch. An `empty` here
  //    would let the next save write a blank block over a day of real hours.
  if (!file || !file.readable || !file.parse) return { verdict: 'unknown' };

  // 3. THE PARSE REFUSED. Carried through unchanged — the codec owns its reasons, and re-deciding
  //    one here is how two rules that merely agree today drift apart.
  if (file.parse.quarantine) return { verdict: 'quarantine', reason: file.parse.reason };

  const fileRev = file.parse.revision;

  // 4. ADOPTED (DD-012, SB-091 rider 1). A note TT is claiming for the first time has no prior
  //    `(rev, digest)` anywhere — a genuinely new row, not a variant of an existing one. Keyed on
  //    the POSITIVE signal `parse.adopted`, never on a missing index row: a missing row also means
  //    "the index was rebuilt" and "TT wrote this before the index existed", which need different
  //    answers and get them below.
  //
  //    `verified: false` on an adopted note is NOT a defect (SB-091 rider 3) — the adopted anchor
  //    deliberately carries no digest, because one computed at adoption time would be taken over
  //    the very bytes it is meant to check.
  if (file.parse.adopted) return { verdict: 'import', rev: fileRev };

  // 5. NO RECORD OF THIS PATH — or a row TT has never parsed a revision out of. Import; there is
  //    nothing to arbitrate against.
  if (!index || index.rev == null) return { verdict: 'import', rev: fileRev };

  // 6. AHEAD. The other machine wrote it, which is the whole point of a shared vault.
  if (fileRev > index.rev) return { verdict: 'import', rev: fileRev };

  // 7. SAME REVISION. Row 2 of SB-057's body does NOT split three ways: a present-and-wrong digest
  //    never reaches here (see the header). Two branches, and `verified` is the discriminator.
  if (fileRev === index.rev) {
    if (file.payloadDigest != null && file.payloadDigest === index.payloadDigest) return { verdict: 'skip' };
    // A block whose own digest checks out but whose payload is not the payload TT recorded at this
    // revision: someone edited the table without moving the counter. Take the rows, then rewrite at
    // rev+1 so TT's counter is meaningful again.
    if (file.parse.verified) return { verdict: 'import-and-rewrite', rev: fileRev + 1 };
    // Digest-less — pre-cutover, hand-made, or freshly adopted. It parses and it is imported; it
    // is simply not vouched for. DD-009 consequence 2 is explicit that this must never quarantine.
    return { verdict: 'import', rev: fileRev };
  }

  // 8. REGRESSED. The three-way split, and the only place TT is entitled to overwrite a note it
  //    did not just read as current.
  //
  //    (a) PROVABLY STALE: the file is at the revision TT recorded as previous, carrying byte for
  //        byte the payload TT recorded at that revision. Nobody edited it — this peer simply has
  //        not caught up. Rewrite it from the index, at the index's OWN revision: the index row
  //        already records `(rev, digest)` for exactly those bytes, so the file lands consistent
  //        with it and the next scan skips.
  if (
    index.prevRev != null &&
    fileRev === index.prevRev &&
    file.payloadDigest != null &&
    index.prevPayloadDigest != null &&
    file.payloadDigest === index.prevPayloadDigest
  ) {
    return { verdict: 'rewrite-from-index', rev: index.rev };
  }
  //    (b) TT RECORDED THAT REVISION AND THE CONTENT DIFFERS. This is SB-061's case: a human
  //        restored the note from the vault's checkpoint history, or another editor rewrote it.
  //        The bytes are not the ones TT wrote at that revision, so TT cannot claim the file is
  //        merely behind — and overwriting here is the silent undo the ticket was filed about.
  if (index.prevRev != null && fileRev === index.prevRev) {
    return { verdict: 'quarantine', reason: 'external-rewrite' };
  }
  //    (c) NO RECORD OF THAT REVISION AT ALL — the regression is more than one revision back, or
  //        the index was rebuilt, or this row's previous pair was never filled. TT cannot prove
  //        staleness, and "rewrite when you cannot prove it" is the same silent undo as (b) with
  //        less evidence behind it. Quarantine.
  return { verdict: 'quarantine', reason: 'unprovable-staleness' };
}
