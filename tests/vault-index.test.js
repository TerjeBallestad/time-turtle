// SB-057 task 2 — the vault index, and the one thing it holds that nothing else can.
//
// The point of this suite is NOT that a row round-trips. It is the RETAINED PREVIOUS PAIR:
// `(prevRev, prevPayloadDigest)`. Everything else here already worked the day the table was
// declared; the previous pair is the field the rev-regression split (design decision 5) reads,
// and a suite that only asserted the current `(rev, digest)` would pass against a table that
// cannot tell "the other machine is one revision behind" from "somebody restored this note from
// git" — which is the distinction SB-061 filed the ticket about.
//
// It also pins design decision 3: `payloadDigest` is `TT.vaultPayloadDigest` (the hash the bottom
// anchor carries) and `fileSha` is a whole-file sha256. Two hashes, two jobs. A test that used the
// file sha as the arbitration input would pass while making that decision false.
//
// The db module is a singleton bound to TT_DATA_DIR at import time, so the env is set before the
// dynamic import. Vitest isolates each file's module registry, so this cannot leak sideways.
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import TT from '../shared/core.js';

/** @type {typeof import('../server/src/db.js')} */
let db;
beforeAll(async () => {
  process.env.TT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tt-vault-index-'));
  db = await import('../server/src/db.js');
});

/** A real block at revision N, and the digest its anchor carries. Built from the serializer, so
 *  the digests under test are the ones a note would actually contain. */
function blockAt(revision, entries) {
  const md = TT.serializeVaultBlock(entries, { heading: 'Time Log', revision });
  const lines = md.split('\n');
  // `['## heading', '', header, delimiter, ...rows]` then '' then the anchor — the payload the
  // digest covers is exactly lines 2..-3, the same slice the serializer hashes.
  return { md, digest: TT.vaultPayloadDigest(lines.slice(2, -2)) };
}
const entry = (id, start, end, label) => ({
  id,
  date: '2026-07-20',
  start,
  end,
  durMin: null,
  project: null,
  label,
  note: '',
  billable: true,
});
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const PATH = '/vault/Calendar/Daily/2026-07-20.md';

describe('the vault index', () => {
  it('a path with no row reads as null — never a zeroed row', () => {
    expect(db.getVaultIndex('/vault/Calendar/Daily/1999-01-01.md')).toBe(null);
    // the dangerous near-miss: a zeroed row would read as `rev: 0`, which arbitration would
    // compare against a real revision and treat as a regression
    expect(db.getVaultIndexByDate('1999-01-01')).toEqual([]);
  });

  it('a fresh row records (rev, digest) with the previous pair still empty', () => {
    const one = blockAt(1, [entry('e1', 540, 600, 'first')]);
    db.putVaultIndex({
      path: PATH,
      date: '2026-07-20',
      state: 'known',
      rev: 1,
      payloadDigest: one.digest,
      fileSha: sha(one.md),
      verified: true,
      quarantineReason: null,
      seenAt: '2026-07-20T09:00:00.000Z',
      writtenAt: '2026-07-20T09:00:00.000Z',
    });
    const row = db.getVaultIndex(PATH);
    expect(row.rev).toBe(1);
    expect(row.payloadDigest).toBe(one.digest);
    // there IS no previous revision yet, and saying so as null rather than 0 is what stops
    // arbitration from claiming it can vouch for a revision that never existed
    expect(row.prevRev).toBe(null);
    expect(row.prevPayloadDigest).toBe(null);
    expect(row.verified).toBe(true);
  });

  it('a second write rolls the old pair into prev_*, and a third loses the one before it', () => {
    const one = blockAt(1, [entry('e1', 540, 600, 'first')]);
    const two = blockAt(2, [entry('e1', 540, 600, 'first'), entry('e2', 600, 660, 'second')]);
    const three = blockAt(3, [entry('e1', 540, 630, 'first, longer')]);
    // the digests must genuinely differ, or the roll-forward assertions below would be vacuous
    expect(new Set([one.digest, two.digest, three.digest]).size).toBe(3);

    db.putVaultIndex({ path: PATH, date: '2026-07-20', state: 'known', rev: 2, payloadDigest: two.digest });
    let row = db.getVaultIndex(PATH);
    expect(row.rev).toBe(2);
    expect(row.payloadDigest).toBe(two.digest);
    expect(row.prevRev).toBe(1);
    expect(row.prevPayloadDigest).toBe(one.digest);

    db.putVaultIndex({ path: PATH, date: '2026-07-20', state: 'known', rev: 3, payloadDigest: three.digest });
    row = db.getVaultIndex(PATH);
    expect(row.rev).toBe(3);
    expect(row.prevRev).toBe(2);
    expect(row.prevPayloadDigest).toBe(two.digest);
    // EXACTLY ONE previous pair is the decision, not an accident: revision 1 is gone, and
    // arbitration must therefore quarantine a file that comes back claiming it (decision 5c).
    expect(row.prevPayloadDigest).not.toBe(one.digest);
    expect(row.prevRev).not.toBe(1);
  });

  it('an idempotent re-put does not shift the current pair into prev_*', () => {
    // The interval scan touches `seenAt` on files that have not moved. If that rolled the pair
    // forward, `prev` would become the CURRENT revision and a genuinely stale peer one revision
    // behind would quarantine instead of being rewritten from the index. One previous DISTINCT
    // pair is what "exactly one previous pair" has to mean.
    const before = db.getVaultIndex(PATH);
    db.putVaultIndex({
      path: PATH,
      date: '2026-07-20',
      state: 'known',
      rev: before.rev,
      payloadDigest: before.payloadDigest,
      seenAt: '2026-07-20T10:00:00.000Z',
    });
    const after = db.getVaultIndex(PATH);
    expect(after.seenAt).toBe('2026-07-20T10:00:00.000Z');
    expect(after.prevRev).toBe(before.prevRev);
    expect(after.prevPayloadDigest).toBe(before.prevPayloadDigest);
  });

  it('a caller cannot set the previous pair — putVaultIndex owns it', () => {
    // Handing it in must not stick: a caller-set previous pair is a payload TT never wrote, and
    // the rev-regression split would then vouch for bytes it has never seen.
    const four = blockAt(4, [entry('e9', 480, 540, 'forged')]);
    db.putVaultIndex({
      path: PATH,
      date: '2026-07-20',
      state: 'known',
      rev: 4,
      payloadDigest: four.digest,
      prevRev: 99,
      prevPayloadDigest: 'dead',
    });
    const row = db.getVaultIndex(PATH);
    expect(row.prevRev).toBe(3);
    expect(row.prevPayloadDigest).not.toBe('dead');
  });

  it('the payload digest is the anchor’s hash, not the whole-file sha (design decision 3)', () => {
    // Different question, different input. The file sha moves when Terje edits `## Captures`;
    // the payload digest does not, and only the payload digest is comparable to what a note
    // actually carries in its `revision: N · a3f1` line.
    const five = blockAt(5, [entry('e1', 540, 600, 'first')]);
    const note = '# Monday\n\n## Intentions\n\nship it\n\n' + five.md + '\n\n## Captures\n\nnothing\n';
    const noteEdited = note.replace('nothing', 'something else entirely');
    db.putVaultIndex({
      path: PATH,
      date: '2026-07-20',
      state: 'known',
      rev: 5,
      payloadDigest: five.digest,
      fileSha: sha(note),
    });
    const row = db.getVaultIndex(PATH);
    expect(row.payloadDigest).toBe(five.digest);
    expect(row.payloadDigest).toHaveLength(4); // the 16-bit FNV the anchor carries, not a sha256
    expect(row.fileSha).toBe(sha(note));
    expect(row.fileSha).not.toBe(sha(noteEdited)); // a Captures edit moves it…
    // …and the anchor's digest is unmoved by that same edit, which is the whole reason the two
    // fields exist separately
    const relocated = TT.parseVaultBlock(noteEdited, { heading: 'Time Log', date: '2026-07-20' });
    expect(relocated.quarantine).toBe(false);
    expect(relocated.revision).toBe(5);
  });

  it('state round-trips all three values, and an unrecognised one degrades to unknown', () => {
    for (const state of ['known', 'unknown', 'quarantined']) {
      db.putVaultIndex({ path: PATH, date: '2026-07-20', state, rev: 5, payloadDigest: 'aaaa' });
      expect(db.getVaultIndex(PATH).state).toBe(state);
    }
    // `unknown` is the safe row: it licenses no write, so a junk value costs a re-read, never a byte
    db.putVaultIndex({ path: PATH, date: '2026-07-20', state: 'sideways', rev: 5, payloadDigest: 'aaaa' });
    expect(db.getVaultIndex(PATH).state).toBe('unknown');
  });

  it('rows are reachable by date and as a whole list, and deletable', () => {
    const other = '/vault/Calendar/Daily/2026-07-21.md';
    db.putVaultIndex({ path: other, date: '2026-07-21', state: 'quarantined', quarantineReason: 'digest-mismatch' });
    expect(db.getVaultIndexByDate('2026-07-21').map((r) => r.path)).toEqual([other]);
    expect(db.getVaultIndexByDate('2026-07-21')[0].quarantineReason).toBe('digest-mismatch');
    expect(db.listVaultIndex().map((r) => r.path)).toEqual([PATH, other].sort());
    db.deleteVaultIndex(other);
    expect(db.getVaultIndex(other)).toBe(null);
    expect(db.listVaultIndex().map((r) => r.path)).toEqual([PATH]);
  });
});

// ## Verified red-green: 2026-07-26
