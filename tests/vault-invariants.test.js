// SB-057 task 7 — the four invariants, at the SYNC-ENGINE level.
//
// One describe per invariant, so a failure names which one broke. The distinction that makes this
// file worth having: SB-055's suite already pins the CODEC. What is claimed here is that the whole
// read-arbitrate-write path holds them — which is where a path-resolution bug, an encoding bug, a
// scope bug or a "helpful" rewrite would actually live.
//
// Invariant 4's current wording, and the two that moved, are restated at the top of
// server/src/vault-sync.js. If a claim here and a comment there ever disagree, the comment is the
// one to fix — but they are meant to be one statement in two places on purpose.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';

/** @type {typeof import('../server/src/vault-sync.js')} */
let sync;
/** @type {typeof import('../server/src/db.js')} */
let db;
/** @type {typeof import('../server/src/vault-write.js')} */
let writer;

let vaultRoot = '';
let dailyDir = '';
let userId = 0;

const HEADING = 'Time Log';
const DATE = '2026-07-20';
const notePath = (date = DATE) => join(dailyDir, date + '.md');

const entry = (id, start, end, label, date = DATE) => ({
  id,
  date,
  start,
  end,
  durMin: null,
  project: null,
  label,
  note: '',
  billable: true,
});

/** A REAL daily note: Terje's four sections, with prose in each, around TT's block. */
const fullNote = (entries, revision) =>
  [
    '# Monday 20 July',
    '',
    '## Intentions',
    '',
    'Ship the sync engine. Do not break the vault.',
    '',
    '- [ ] a task with a `|` pipe in it',
    '',
    TT.serializeVaultBlock(entries, { heading: HEADING, revision }),
    '',
    '## Captures',
    '',
    'A stray thought about Tuesday — with an em dash, a `revision: 3` lookalike, and «quotes».',
    '',
    '## Reflection',
    '',
    'Went fine.',
    '',
  ].join('\n');

/** The lines OUTSIDE the block's region, given the note's own bounds. */
function outsideBlock(md) {
  const loc = TT.locateVaultBlock(md, { heading: HEADING });
  if (loc.quarantine) throw new Error('fixture does not locate: ' + loc.reason);
  const lines = md.split('\n');
  return { before: lines.slice(0, loc.start), after: lines.slice(loc.end + 1) };
}

/** Save an entry set through the REAL write path — `store.putEntries` under the vault backend. */
async function saveThroughStore(entries) {
  const before = db.getEntries(userId);
  db.putEntries(userId, entries);
  return writer.writeVaultEntries(userId, entries, before);
}

beforeAll(async () => {
  process.env.TT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tt-invariants-data-'));
  process.env.TT_SHAPE = 'personal';
  db = await import('../server/src/db.js');
  sync = await import('../server/src/vault-sync.js');
  writer = await import('../server/src/vault-write.js');
  const user = db.createUser({ email: 'solo@timeturtle.local', name: 'Solo', role: 'admin', password: 'pw' });
  userId = user.id;
});

beforeEach(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'tt-invariants-'));
  dailyDir = join(vaultRoot, 'Calendar', 'Daily');
  mkdirSync(dailyDir, { recursive: true });
  db.putSettings({ shape: 'personal', vaultPaths: { root: vaultRoot, daily: 'Calendar/Daily' } });
  db.db.exec("INSERT INTO settings (key, value) VALUES ('vaultCutover', '2020-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value = excluded.value"); // prettier-ignore
  for (const row of db.listVaultIndex()) db.deleteVaultIndex(row.path);
  db.putEntries(userId, []);
  sync.forgetOwnWrites();
});
afterEach(() => {
  try {
    chmodSync(notePath(), 0o644);
  } catch {
    /* the file may not exist, or may never have been chmodded */
  }
  rmSync(vaultRoot, { recursive: true, force: true });
});

// ============================================================================================
describe('invariant 1 — unreadable or absent is UNKNOWN, never EMPTY', () => {
  // What SB-052 changed: eviction is NOT what this defends against (an evicted file reads fine,
  // via a ~1 s download). It covers a genuine partial-sync state, a permissions failure, and an
  // offline read that times out.
  const THREE = [
    entry('e1', 480, 540, 'first hour'),
    entry('e2', 540, 600, 'second hour'),
    entry('e3', 600, 660, 'third hour'),
  ];

  it('a file that becomes UNREADABLE keeps every entry, and the row goes unknown', async () => {
    writeFileSync(notePath(), fullNote(THREE, 4));
    await sync.scanVault();
    expect(db.getEntries(userId)).toHaveLength(3);

    chmodSync(notePath(), 0o000);
    // Assert the read ACTUALLY failed before asserting what TT did about it — running as root
    // would make chmod 000 a no-op and this whole case a lie.
    let readable = true;
    try {
      readFileSync(notePath(), 'utf8');
    } catch {
      readable = false;
    }
    if (!readable) {
      const counts = await sync.scanVault();
      expect(counts.unknown).toBe(1);
      expect(db.getEntries(userId).map((e) => e.label)).toEqual(['first hour', 'second hour', 'third hour']);
      expect(db.getVaultIndex(notePath()).state).toBe('unknown');
      expect(db.getVaultIndex(notePath()).rev).toBe(4); // what TT knew is unconfirmed, not forgotten
    } else {
      // Never silently skipped: an environment where chmod cannot make a file unreadable must say
      // so, or a green run here would be meaningless.
      expect.fail('chmod 000 did not make the file unreadable — running as root?');
    }
  });

  it('a read that TIMES OUT does exactly the same thing (the offline case SB-052 could not test)', async () => {
    writeFileSync(notePath(), fullNote(THREE, 4));
    await sync.scanVault();
    const counts = await sync.scanVault({ readFile: () => new Promise(() => {}), timeoutMs: 20 });
    expect(counts.unknown).toBe(1);
    expect(db.getEntries(userId)).toHaveLength(3);
    expect(db.getVaultIndex(notePath()).state).toBe('unknown');
  });

  it('a file that VANISHES keeps every entry — absence is never a deletion', async () => {
    writeFileSync(notePath(), fullNote(THREE, 4));
    await sync.scanVault();
    unlinkSync(notePath());
    const verdict = await sync.syncVaultPath(notePath(), DATE, sync.vaultSyncConfig());
    expect(verdict).toBe('unknown');
    expect(db.getEntries(userId)).toHaveLength(3);
    expect(db.getVaultIndex(notePath()).state).toBe('unknown');
  });

  it('and a day left UNKNOWN is a day the writer refuses to touch', async () => {
    // The two halves of the invariant meeting: `unknown` on the read side is what makes the write
    // side leave the file alone. Without this the whole state would be a comment.
    const md = fullNote(THREE, 4);
    writeFileSync(notePath(), md);
    await sync.scanVault({ readFile: () => Promise.reject(new Error('EACCES')), timeoutMs: 50 });
    expect(db.getVaultIndex(notePath()).state).toBe('unknown');
    const report = await saveThroughStore([entry('later', 900, 960, 'typed in the app')]);
    expect(report.written).toEqual([]);
    expect(readFileSync(notePath(), 'utf8')).toBe(md);
  });
});

// ============================================================================================
describe('invariant 2 — an unparseable block is quarantined, surfaced, and LEFT ALONE', () => {
  // DD-014's rider: quarantine rather than write a DEGRADED cell. The block is a lossless carrier
  // because `personal → team` is the upgrade path.
  const DAMAGED = [
    // Both matched on cell CONTENT rather than on compact bytes: DD-023 pads a cell out to its
    // column width, so `'| Time |'` and `/\| ✓ \|$/` each stopped matching and the "damaged"
    // fixture went to the scanner undamaged — a quarantine test asserting a quarantine that could
    // no longer happen.
    ['unknown-header', (md) => md.replace(/^\| Time\b/m, '| Cat')],
    ['bad-bill-cell', (md) => md.replace(/\| ✓ *\|$/m, '| yes |')],
    ['unexpected-content-in-block', (md) => md.replace('\n\n`revision:', '\na note to self\n\n`revision:')],
    ['unparseable-time', (md) => md.replace('| 08:00→09:00 |', '| half past |')],
  ];

  for (const [reason, damage] of DAMAGED) {
    it(`${reason}: the file is byte-identical afterwards and the row carries the reason`, async () => {
      // Unsigned first: a signed block would refuse as `digest-mismatch` (the locator's gate firing
      // ahead of the parser), which is correct but is a different reason than the one under test.
      const signed = fullNote([entry('e1', 480, 540, 'an hour')], 4);
      const md = damage(signed.replace(/`revision: (\d+) · [0-9a-f]{4}`/, '`revision: $1`'));
      writeFileSync(notePath(), md);

      const counts = await sync.scanVault();
      expect(counts.quarantine).toBe(1);
      const row = db.getVaultIndex(notePath());
      expect(row.state).toBe('quarantined');
      expect(row.quarantineReason).toBe(reason);
      expect(readFileSync(notePath(), 'utf8')).toBe(md);
      // …and nothing was imported out of it: a partial read is a degraded cell by another name
      expect(db.getEntries(userId)).toEqual([]);

      // Now the WRITE side of the same invariant — a save must not overwrite it either.
      const report = await saveThroughStore([entry('later', 900, 960, 'typed in the app')]);
      expect(report.written).toEqual([]);
      expect(report.refused.map((r) => r.reason)).toContain(reason);
      expect(readFileSync(notePath(), 'utf8')).toBe(md);
    });
  }

  it('a note that breaks BETWEEN the scan and the save is quarantined by the WRITER, not overwritten', () => {
    // The one path that reaches the writer's own quarantine recording. The scan read this note
    // fine, so its row is `known` and `writeEligibility` says `write` — and then a human edits it
    // into something `writeVaultBlock` refuses. Without the recording, the row stays `known`, the
    // Settings surface shows nothing, and the next save tries again forever.
    const good = fullNote([entry('e1', 480, 540, 'an hour')], 4);
    writeFileSync(notePath(), good);
    return sync.scanVault().then(async () => {
      expect(db.getVaultIndex(notePath()).state).toBe('known');
      const damaged = good.replace(/\n\n`revision:/, '\nI wrote a sentence in here\n\n`revision:');
      writeFileSync(notePath(), damaged);

      const report = await saveThroughStore([entry('e1', 480, 600, 'an hour, longer')]);
      expect(report.written).toEqual([]);
      expect(report.refused.map((r) => r.reason)).toContain('unexpected-content-in-block');
      expect(readFileSync(notePath(), 'utf8')).toBe(damaged); // left alone, byte for byte
      const row = db.getVaultIndex(notePath());
      expect(row.state, 'the writer refused but left the row saying `known`').toBe('quarantined');
      expect(row.quarantineReason).toBe('unexpected-content-in-block');
      expect(row.rev).toBe(4); // what TT knew is not forgotten
    });
  });
});

// ============================================================================================
describe('invariant 3 — TT never writes outside its own markers', () => {
  it('a full save through the engine leaves every byte of every other section identical', async () => {
    // NOT asserted against `TT.writeVaultBlock` alone — SB-055 already pins that. The claim here is
    // about the SYNC ENGINE's whole write path, which is where a path-resolution or encoding bug
    // would live. Arrays are compared, not substrings: a substring check passes on a file that
    // gained a line.
    const md = fullNote([entry('e1', 480, 540, 'an hour')], 4);
    writeFileSync(notePath(), md);
    await sync.scanVault();
    expect(db.getVaultIndex(notePath()).state).toBe('known');
    const before = outsideBlock(md);

    const report = await saveThroughStore([
      entry('e1', 480, 540, 'an hour'),
      entry('e2', 600, 675, 'a second, longer hour with a | pipe'),
    ]);
    expect(report.written).toEqual([DATE]);

    const after = readFileSync(notePath(), 'utf8');
    const outside = outsideBlock(after);
    expect(outside.before).toEqual(before.before);
    expect(outside.after).toEqual(before.after);
    // and the block really did change, so the assertion above is not about a file nobody wrote
    const parsed = TT.parseVaultBlock(after, { heading: HEADING, date: DATE });
    expect(parsed.entries.map((e) => e.label)).toEqual(['an hour', 'a second, longer hour with a | pipe']);
    expect(parsed.revision).toBe(5);
  });

  it('the `revision:` lookalike in Terje’s Captures section is not an anchor and is untouched', async () => {
    const md = fullNote([entry('e1', 480, 540, 'an hour')], 4);
    expect(md).toContain('a `revision: 3` lookalike');
    writeFileSync(notePath(), md);
    await sync.scanVault();
    await saveThroughStore([entry('e1', 480, 540, 'an hour, edited')]);
    expect(readFileSync(notePath(), 'utf8')).toContain('a `revision: 3` lookalike');
  });
});

// ============================================================================================
describe('invariant 4 (RESTATED) — what TT may claim', () => {
  // "TT claims a note that carries the anchor heading exactly once and whose region between it and
  // the next `##` (or EOF) TT can describe completely. On first write TT writes the bottom anchor
  // itself. Anything else it refuses and leaves alone." (SB-045 + DD-012, superseding SDD-003.)
  const around = (region) => `# Monday\n\n## Intentions\n\nplans\n\n${region}\n\n## Captures\n\nthoughts\n`;

  it('a well-formed table with NO anchor is ADOPTED, imported and written (DD-012)', async () => {
    const md = around(`## ${HEADING}\n\n| Time | Task |\n|---|---|\n| 08:00→09:00 | his own morning |`);
    writeFileSync(notePath(), md);
    const counts = await sync.scanVault();
    expect(counts.import).toBe(1);
    expect(db.getEntries(userId).map((e) => e.label)).toEqual(['his own morning']);
    // …and the first write puts the bottom anchor there, with a digest — TT always writes one
    await saveThroughStore([entry('e1', 480, 540, 'his own morning'), entry('e2', 600, 660, 'and an afternoon')]);
    const after = readFileSync(notePath(), 'utf8');
    expect(after).toMatch(/`revision: \d+ · [0-9a-f]{4}`/);
    expect(TT.parseVaultBlock(after, { heading: HEADING, date: DATE }).verified).toBe(true);
    expect(after).toContain('## Captures'); // and the rest of the note is still his
  });

  it('the heading with PROSE under it is refused and left alone', async () => {
    const md = around(`## ${HEADING}\n\nI wrote about my morning here instead of logging it.`);
    writeFileSync(notePath(), md);
    expect((await sync.scanVault()).quarantine).toBe(1);
    expect(readFileSync(notePath(), 'utf8')).toBe(md);
    const report = await saveThroughStore([entry('e1', 480, 540, 'typed in the app')]);
    expect(report.written).toEqual([]);
    expect(readFileSync(notePath(), 'utf8')).toBe(md);
  });

  it('the heading with SB-049’s vocabulary is refused — and SB-044 is what would open it', async () => {
    // THIS IS THE ONE THAT KEEPS SB-049's 60 PRE-CUTOVER NOTES CLOSED. They carry the heading and
    // a perfectly well-formed table; it is `Cat` and `Description` failing the vocabulary that
    // refuses them, not the heading. SB-044 extends that vocabulary from settings and is therefore
    // LOAD-BEARING here: adding those two labels would open all 60 to adoption in one commit.
    // SB-091 left a test that goes red if that happens — do not weaken it.
    const md = around(
      `## ${HEADING}\n\n| Time | Cat | Project | Description |\n|---|---|---|---|\n| 08:00-09:00 | work | Fjellheim | morning |`,
    );
    writeFileSync(notePath(), md);
    const counts = await sync.scanVault();
    expect(counts.quarantine).toBe(1);
    expect(db.getVaultIndex(notePath()).quarantineReason).toBe('unknown-header');
    expect(db.getEntries(userId)).toEqual([]);
    expect(readFileSync(notePath(), 'utf8')).toBe(md);
  });

  it('TWO anchor headings is not a note TT can describe, so it claims neither', async () => {
    const region = `## ${HEADING}\n\n| Time | Task |\n|---|---|\n| 08:00→09:00 | one |`;
    const md = around(region) + `\n## ${HEADING}\n\n| Time | Task |\n|---|---|\n| 10:00→11:00 | two |\n`;
    writeFileSync(notePath(), md);
    expect((await sync.scanVault()).quarantine).toBe(1);
    expect(db.getVaultIndex(notePath()).quarantineReason).toBe('multiple-headings');
    expect(readFileSync(notePath(), 'utf8')).toBe(md);
  });

  it('the heading name comes from SETTINGS and is never a constant', async () => {
    db.putSettings({ vaultPaths: { root: vaultRoot, daily: 'Calendar/Daily', timeLogHeading: 'Tidslogg' } });
    const md = around('## Tidslogg\n\n| Time | Task |\n|---|---|\n| 08:00→09:00 | min morgen |');
    writeFileSync(notePath(), md);
    expect((await sync.scanVault()).import).toBe(1);
    expect(db.getEntries(userId).map((e) => e.label)).toEqual(['min morgen']);
  });
});

// ## Verified red-green: 2026-07-26 — invariant 1
// ## Verified red-green: 2026-07-26 — invariant 2
// ## Verified red-green: 2026-07-26 — invariant 3
// ## Verified red-green: 2026-07-26 — invariant 4
