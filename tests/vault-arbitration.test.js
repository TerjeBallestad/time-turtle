// SB-057 task 4 — every row of the arbitration matrix, as a genuine table.
//
// One array of cases, one `it.each`. Every fixture is built by the REAL codec —
// `TT.serializeVaultBlock` writes the block, `describeVaultFile` reads it back through
// `TT.locateVaultBlock` / `TT.parseVaultBlock` / `TT.vaultPayloadDigest`. A hand-written markdown
// string would drift away from what the serializer emits, and a matrix that passes against a note
// shape that no longer exists proves nothing.
//
// THE THREE REV-REGRESSION ROWS GET BOTH DIRECTIONS. Each of them has at least one case that must
// quarantine AND one that must not, because a function that simply always quarantined would pass a
// one-sided suite — and would also break two-machine catch-up completely, which is the failure
// nobody would notice until a laptop came back from a week away.
//
// Note what is NOT here: `digest-mismatch` is not a rev-comparison row. The locator refuses it
// before the parser runs (DD-009 / design decision 6), so it arrives as an ordinary quarantine and
// the matrix's only job is to carry the reason. It appears below as exactly that.
import { describe, it, expect } from 'vitest';
import TT, {
  VAULT_ADOPTABLE_QUARANTINE_REASONS,
  VAULT_ARBITRATION_QUARANTINE_REASONS,
  VAULT_BLOCK_QUARANTINE_REASONS,
} from '../shared/core.js';
import { arbitrate, describeVaultFile, fileSha } from '../server/src/vault-arbitrate.js';

const HEADING = 'Time Log';
const DATE = '2026-07-20';
const opts = { heading: HEADING, date: DATE };

const entry = (id, start, end, label) => ({
  id,
  date: DATE,
  start,
  end,
  durMin: null,
  project: null,
  label,
  note: '',
  billable: true,
});
/** A running row: a start and no end. Ordinary content — see design decision 16. */
const running = (id, start, label) => entry(id, start, null, label);

/** A whole daily note with real sections around the block, at revision N. */
function note(entries, revision) {
  return (
    '# Monday 20 July\n\n## Intentions\n\nship the sync engine\n\n' +
    TT.serializeVaultBlock(entries, { heading: HEADING, revision }) +
    '\n\n## Captures\n\nnothing yet\n'
  );
}
/** The same note with its anchor's digest stripped — a block TT did not write (DD-009 consequence 2). */
const unsigned = (md) => md.replace(/`revision: (\d+) · [0-9a-f]{4}`/, '`revision: $1`');
/** The note with no bottom anchor at all — the DD-012 adoption shape. */
const anchorless = (md) => md.replace(/\n\n`revision: \d+(?: · [0-9a-f]{4})?`/, '');

const DAY_ONE = [entry('e1', 540, 600, 'first')];
const DAY_TWO = [entry('e1', 540, 600, 'first'), entry('e2', 600, 660, 'second')];
const DAY_THREE = [entry('e1', 540, 630, 'first, longer')];

/** An index row, defaulted to a plausible `known` row so a case names only what it is about. */
const index = (over) => ({
  path: '/vault/Calendar/Daily/2026-07-20.md',
  date: DATE,
  state: 'known',
  rev: null,
  payloadDigest: null,
  prevRev: null,
  prevPayloadDigest: null,
  fileSha: null,
  verified: null,
  quarantineReason: null,
  seenAt: null,
  writtenAt: null,
  ...over,
});
/** The index row TT would hold having written `entries` at `revision`. */
function indexFor(entries, revision, over) {
  const md = note(entries, revision);
  const read = describeVaultFile(md, opts);
  return index({ rev: revision, payloadDigest: read.payloadDigest, fileSha: read.sha, verified: true, ...over });
}

// The digests really must differ across the three days, or half the table below is vacuous.
const D1 = describeVaultFile(note(DAY_ONE, 1), opts).payloadDigest;
const D2 = describeVaultFile(note(DAY_TWO, 2), opts).payloadDigest;
const D3 = describeVaultFile(note(DAY_THREE, 3), opts).payloadDigest;

describe('the vault arbitration matrix', () => {
  it('the fixtures are genuinely distinct — otherwise the digest comparisons prove nothing', () => {
    expect(new Set([D1, D2, D3]).size).toBe(3);
    expect(D1).toMatch(/^[0-9a-f]{4}$/); // the anchor's 16-bit FNV, not a sha256
  });

  const cases = [
    // ---- the cheap exit ----
    {
      name: 'file unchanged (file_sha matches the index) → skip',
      file: () => describeVaultFile(note(DAY_TWO, 2), opts),
      index: () => indexFor(DAY_TWO, 2),
      expect: { verdict: 'skip' },
    },
    {
      name: 'unchanged even when the index row is quarantined — nothing moved, so nothing is re-decided',
      file: () => describeVaultFile(note(DAY_TWO, 2), opts),
      index: () => indexFor(DAY_TWO, 2, { state: 'quarantined', quarantineReason: 'external-rewrite' }),
      expect: { verdict: 'skip' },
    },

    // ---- invariant 1: unreadable is UNKNOWN, never empty ----
    {
      name: 'absent → unknown (never "empty", never a deletion)',
      file: () => null,
      index: () => indexFor(DAY_TWO, 2),
      expect: { verdict: 'unknown' },
    },
    {
      name: 'unreadable → unknown',
      file: () => ({ readable: false, sha: null, payloadDigest: null, parse: null }),
      index: () => indexFor(DAY_TWO, 2),
      expect: { verdict: 'unknown' },
    },
    {
      name: 'the read timed out → unknown, exactly like unreadable',
      file: () => ({ readable: false, sha: null, payloadDigest: null, parse: null }),
      index: () => null,
      expect: { verdict: 'unknown' },
    },

    // ---- the codec refused ----
    {
      name: 'digest-mismatch → quarantine carrying the codec’s own reason (never a rev-comparison row)',
      file: () => describeVaultFile(note(DAY_TWO, 2).replace('| 09:00→10:00 |', '| 09:15→10:00 |'), opts),
      index: () => indexFor(DAY_TWO, 2, { fileSha: 'something-else' }),
      expect: { verdict: 'quarantine', reason: 'digest-mismatch' },
    },
    {
      // UNSIGNED on purpose: renaming a column in a SIGNED block trips the digest first, which is
      // the locator doing its job and not this row. Stripping the anchor's digest is what lets the
      // parser's own refusal be the one under test.
      name: 'an unknown header → quarantine carrying that reason',
      // matched on the header's first cell, not on the literal `| Time |` — DD-023 widened that
      // cell to its column, so the literal replaced nothing and the fixture reached the arbiter
      // as a perfectly good block claiming to be an unknown header
      file: () => describeVaultFile(unsigned(note(DAY_TWO, 2)).replace(/^\| Time\b/m, '| Cat'), opts),
      index: () => null,
      expect: { verdict: 'quarantine', reason: 'unknown-header' },
    },
    {
      name: 'stray prose inside the block → quarantine, and TT leaves the note alone',
      file: () =>
        describeVaultFile(unsigned(note(DAY_TWO, 2)).replace('\n\n`revision:', '\na note to self\n\n`revision:'), opts),
      index: () => null,
      expect: { verdict: 'quarantine', reason: 'unexpected-content-in-block' },
    },

    // ---- DD-012 adoption ----
    {
      name: 'adopted (DD-012) → import — no prior (rev, digest) exists anywhere',
      file: () => describeVaultFile(anchorless(note(DAY_TWO, 2)), opts),
      index: () => null,
      expect: { verdict: 'import', rev: 1 },
    },
    {
      name: 'adopted is keyed on the POSITIVE signal, not on an absent index row',
      file: () => describeVaultFile(anchorless(note(DAY_TWO, 2)), opts),
      index: () => indexFor(DAY_ONE, 7), // a row exists, and adoption still wins
      expect: { verdict: 'import' },
    },

    // ---- no record ----
    {
      name: 'no index row at all, block parses → import',
      file: () => describeVaultFile(note(DAY_TWO, 2), opts),
      index: () => null,
      expect: { verdict: 'import', rev: 2 },
    },
    {
      name: 'an index row TT has never parsed a revision out of → import',
      file: () => describeVaultFile(note(DAY_TWO, 2), opts),
      index: () => index({ state: 'unknown' }),
      expect: { verdict: 'import', rev: 2 },
    },

    // ---- ahead ----
    {
      name: 'file.rev > index.rev → import (the other machine wrote it)',
      file: () => describeVaultFile(note(DAY_THREE, 3), opts),
      index: () => indexFor(DAY_TWO, 2),
      expect: { verdict: 'import', rev: 3 },
    },

    // ---- same revision ----
    {
      name: 'same rev, payload digest matches → skip',
      file: () => describeVaultFile(note(DAY_TWO, 2), opts),
      index: () => indexFor(DAY_TWO, 2, { fileSha: 'stale-whole-file-sha' }),
      expect: { verdict: 'skip' },
    },
    {
      name: 'same rev, digest differs, verified → import-and-rewrite at rev+1 (a bumpless hand-edit)',
      file: () => describeVaultFile(note(DAY_THREE, 2), opts),
      index: () => indexFor(DAY_TWO, 2),
      expect: { verdict: 'import-and-rewrite', rev: 3 },
    },
    {
      name: 'same rev, digest differs, NOT verified → import as unverified (digest-less, never a refusal)',
      file: () => describeVaultFile(unsigned(note(DAY_THREE, 2)), opts),
      index: () => indexFor(DAY_TWO, 2),
      expect: { verdict: 'import', rev: 2 },
    },

    // ---- the rev regression, all three sub-cases, both directions ----
    {
      name: 'REGRESSION (a): matches the recorded previous (rev, digest) → rewrite-from-index, at the index’s rev',
      file: () => describeVaultFile(note(DAY_TWO, 2), opts),
      index: () => indexFor(DAY_THREE, 3, { prevRev: 2, prevPayloadDigest: D2 }),
      expect: { verdict: 'rewrite-from-index', rev: 3 },
    },
    {
      name: 'REGRESSION (a), a second pair — a peer several revisions old but recorded as previous is still rewritten',
      file: () => describeVaultFile(note(DAY_ONE, 5), opts),
      index: () => indexFor(DAY_THREE, 9, { prevRev: 5, prevPayloadDigest: D1 }),
      expect: { verdict: 'rewrite-from-index', rev: 9 },
    },
    {
      name: 'REGRESSION (b): TT recorded that rev and the payload DIFFERS → quarantine, the deliberate git restore',
      file: () => describeVaultFile(note(DAY_ONE, 2), opts),
      index: () => indexFor(DAY_THREE, 3, { prevRev: 2, prevPayloadDigest: D2 }),
      expect: { verdict: 'quarantine', reason: 'external-rewrite' },
    },
    {
      name: 'REGRESSION (b) with a digest-less file at the recorded rev → still quarantine, never a rewrite',
      file: () => describeVaultFile(unsigned(note(DAY_ONE, 2)), opts),
      index: () => indexFor(DAY_THREE, 3, { prevRev: 2, prevPayloadDigest: D2 }),
      expect: { verdict: 'quarantine', reason: 'external-rewrite' },
    },
    {
      name: 'REGRESSION (c): more than one revision back → quarantine, TT cannot prove staleness',
      file: () => describeVaultFile(note(DAY_ONE, 1), opts),
      index: () => indexFor(DAY_THREE, 3, { prevRev: 2, prevPayloadDigest: D2 }),
      expect: { verdict: 'quarantine', reason: 'unprovable-staleness' },
    },
    {
      name: 'REGRESSION (c): the index was rebuilt, so there is no previous pair → quarantine',
      file: () => describeVaultFile(note(DAY_TWO, 2), opts),
      index: () => indexFor(DAY_THREE, 3), // prevRev/prevPayloadDigest both null
      expect: { verdict: 'quarantine', reason: 'unprovable-staleness' },
    },

    // ---- design decision 16: a running row is ordinary content, not a special case ----
    {
      name: 'a RUNNING row, unchanged → skip like any other content (SB-050 is where the ruling lives)',
      file: () => describeVaultFile(note([running('e1', 1054, 'still going')], 4), opts),
      index: () => indexFor([running('e1', 1054, 'still going')], 4),
      expect: { verdict: 'skip' },
    },
    {
      name: 'a RUNNING row closed on the other machine → import like any other change',
      file: () => describeVaultFile(note([entry('e1', 1054, 1140, 'still going')], 5), opts),
      index: () => indexFor([running('e1', 1054, 'still going')], 4),
      expect: { verdict: 'import', rev: 5 },
    },
  ];

  it.each(cases)('$name', ({ file, index: idx, expect: want }) => {
    const got = arbitrate({ file: file(), index: idx() });
    expect(got.verdict).toBe(want.verdict);
    if (want.reason !== undefined) expect(got.reason).toBe(want.reason);
    if (want.rev !== undefined) expect(got.rev).toBe(want.rev);
    // a verdict that is not a refusal must never carry a reason, or a quarantine surface would
    // render a line about a note that is perfectly fine
    if (want.verdict !== 'quarantine') expect(got.reason).toBe(undefined);
  });

  it('the whole-file sha is a sha256 and moves on a change outside the block', () => {
    // Design decision 3, from the other side: `fileSha` answers "did anything change at all", which
    // is why it CANNOT be the arbitration input — a `## Captures` edit moves it while the block is
    // untouched, and the payload digest is unmoved by the same edit.
    const md = note(DAY_TWO, 2);
    const edited = md.replace('nothing yet', 'a thought about Tuesday');
    expect(fileSha(md)).toHaveLength(64);
    expect(fileSha(md)).not.toBe(fileSha(edited));
    expect(describeVaultFile(md, opts).payloadDigest).toBe(describeVaultFile(edited, opts).payloadDigest);
    // and the matrix agrees: the file changed, the block did not, so there is nothing to do
    expect(arbitrate({ file: describeVaultFile(edited, opts), index: indexFor(DAY_TWO, 2) }).verdict).toBe('skip');
  });

  it('covers every arbitration-only quarantine reason the matrix can produce', () => {
    // DD-022's completeness guard, the third of a trio. tests/roundtrip.test.js keeps this over
    // the BLOCK half of `VaultQuarantineReason` and tests/catalog.test.js over the catalog half;
    // this one is the arbitration half's, and it is here rather than in either of those files
    // because that is where the goldens are. Neither member can meet the block guard's demand —
    // "emitted in shared/core.js AND carrying a codec refusal golden" — since no note can be
    // written that provokes an arbitration verdict on its own. That is the whole reason DD-022
    // made it a third union instead of two more members, and the reason this guard exists at all.
    //
    // IMPORTED, NOT SCRAPED (SB-109). The catalog guard reads its union out of shared/types.ts
    // with a regex, and its own file records how that went silently vacuous the day the block half
    // moved to a runtime array: the scrape matched zero members, `for (const reason of [])` ran no
    // assertions, and the test stayed green while checking nothing. An import cannot go quiet.
    expect(Array.isArray(VAULT_ARBITRATION_QUARANTINE_REASONS), 'the vocabulary is not an array').toBe(true);
    expect(VAULT_ARBITRATION_QUARANTINE_REASONS.every((r) => typeof r === 'string' && /^[a-z][a-z-]*$/.test(r)), `not all reasons are reason codes: ${JSON.stringify(VAULT_ARBITRATION_QUARANTINE_REASONS)}`).toBe(true); // prettier-ignore
    // Pinned, not `toBeGreaterThan(0)`, for the reason the block guard states: a pin turns "a
    // reason was added" into a deliberate edit here, and makes a shrunken list red rather than
    // quietly easier. DD-022 ruled exactly two, one per PLAN-012 decision 5 sub-case, so the
    // Settings row can say which happened.
    expect(VAULT_ARBITRATION_QUARANTINE_REASONS.length, 'the arbitration vocabulary changed size — add a matrix row, then update this pin').toBe(2); // prettier-ignore

    // EVERY MEMBER IS PRODUCED BY A ROW OF THE TABLE ABOVE. A reason declared and never returned
    // is a branch nobody has ever run — and, since these are what the Settings row switches on,
    // one nobody has ever seen either.
    const produced = new Set(cases.map((c) => arbitrate({ file: c.file(), index: c.index() }).reason));
    for (const reason of VAULT_ARBITRATION_QUARANTINE_REASONS)
      expect(produced.has(reason), `no arbitration-matrix row produces the reason: ${reason}`).toBe(true);

    // AND THE ARBITRATION HALF MUST NOT QUIETLY ACQUIRE A CODEC REASON — the mirror image of the
    // block guard's `catalog-` check. `digest-mismatch` is the one to watch: it is the reason this
    // union sits next to in `VAULT_ADOPTABLE_QUARANTINE_REASONS`, and moving it here would make
    // the matrix responsible for a verdict the locator owns (see this file's header).
    for (const reason of VAULT_ARBITRATION_QUARANTINE_REASONS)
      expect(VAULT_BLOCK_QUARANTINE_REASONS.includes(reason), `a codec reason leaked into the arbitration vocabulary: ${reason}`).toBe(false); // prettier-ignore

    // DD-022's admission argument, as an assertion rather than a paragraph: the gesture is offered
    // on BOTH of these, and on exactly one codec reason besides.
    expect([...VAULT_ADOPTABLE_QUARANTINE_REASONS].sort()).toEqual(
      ['digest-mismatch', ...VAULT_ARBITRATION_QUARANTINE_REASONS].sort(),
    );
  });

  it('every verdict in the union is reachable from the table above', () => {
    // The completeness claim comes from the matrix, not from counting lines in this file — but a
    // verdict no case produces is a branch nobody has ever run.
    const produced = new Set(cases.map((c) => arbitrate({ file: c.file(), index: c.index() }).verdict));
    for (const verdict of ['skip', 'import', 'import-and-rewrite', 'rewrite-from-index', 'quarantine', 'unknown'])
      expect(produced.has(verdict), `no case produces the verdict: ${verdict}`).toBe(true);
  });
});

// ## Verified red-green: 2026-07-26
