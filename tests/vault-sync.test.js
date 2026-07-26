// SB-057 task 5 — the sync engine, against a real temp directory.
//
// WHAT A GREEN RUN HERE DOES NOT PROVE, said once and meant:
//
//   • that macOS fires a watchable event when iCloud LANDS a file written on the other machine. A
//     local `writeFileSync` produces an fsevents event; an iCloud materialisation is a different
//     code path, and the slow interval exists precisely because it may not. That gap is the gate
//     ticket task 9 files, and nothing in this file closes it.
//   • that the boot scan is fast on a cold machine. The dataless branch below is exercised by
//     INJECTING a stat result, because a temp directory cannot be made dataless. The claim "200
//     evicted days no longer stall the boot" is a claim about 200 real downloads, and this file
//     contains none. The real-eviction evidence lives in SB-052 and in task 1's measurements.
//   • that any of it survives being offline. SB-052 could not safely drop the network.
//
// What it DOES prove: an unchanged file is skipped, an external modification imports and
// invalidates the client's version, TT's own write does not echo back, and an unreadable, absent
// or timed-out read yields `unknown` and leaves every entry TT already holds exactly where it is.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';

/** @type {typeof import('../server/src/vault-sync.js')} */
let sync;
/** @type {typeof import('../server/src/db.js')} */
let db;
/** @type {typeof import('../server/src/vault-arbitrate.js')} */
let arb;
/** @type {typeof import('../server/src/vault-write.js')} */
let writer;
/** @type {typeof import('../server/src/store.js')} */
let store;

let vaultRoot = '';
let dailyDir = '';
let userId = 0;

const HEADING = 'Time Log';
const DATE = '2026-07-20';
const notePath = (date = DATE) => join(dailyDir, date + '.md');

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

/** A whole daily note with Terje's own sections around the block. */
const note = (entries, revision, date = DATE) =>
  '# ' +
  date +
  '\n\n## Intentions\n\nship it\n\n' +
  TT.serializeVaultBlock(entries, { heading: HEADING, revision }) +
  '\n\n## Captures\n\nnothing yet\n';

beforeAll(async () => {
  process.env.TT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tt-vault-sync-data-'));
  process.env.TT_SHAPE = 'personal'; // config.js reads this at import; the backend derives from it
  db = await import('../server/src/db.js');
  sync = await import('../server/src/vault-sync.js');
  arb = await import('../server/src/vault-arbitrate.js');
  // Imported HERE, after TT_DATA_DIR is set: db.js binds its file at import time, and a static
  // import in a file that has not set the env would open (and migrate) the repo's own server/data.
  writer = await import('../server/src/vault-write.js');
  // The real seam, so the post-commit ordering below is exercised through the code the API uses.
  store = await import('../server/src/store.js');
  const user = db.createUser({ email: 'solo@timeturtle.local', name: 'Solo', role: 'admin', password: 'pw' });
  userId = user.id;
});

beforeEach(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'tt-vault-sync-'));
  dailyDir = join(vaultRoot, 'Calendar', 'Daily');
  mkdirSync(dailyDir, { recursive: true });
  db.putSettings({ shape: 'personal', vaultPaths: { root: vaultRoot, daily: 'Calendar/Daily' } });
  // a cutover far enough back that the fixtures are all inside it; the cutover's own behaviour is
  // asserted on its own below
  db.db.exec("INSERT INTO settings (key, value) VALUES ('vaultCutover', '2020-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value = excluded.value"); // prettier-ignore
  for (const row of db.listVaultIndex()) db.deleteVaultIndex(row.path);
  db.putEntries(userId, []);
  sync.forgetOwnWrites();
  sync.setVaultRewriter(null);
});
afterEach(() => {
  sync.stopVaultSync();
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe('the vault sync engine', () => {
  it('imports an external write and bumps the entries version so the client cannot overwrite it', () => {
    // DC-001 / design decision 10. Without the bump, the client's next whole-set PUT silently
    // replaces what was just imported — and the writer then puts an empty block over the day.
    const before = db.getVersions(userId).entries;
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'from the other machine')], 4));
    return sync.scanVault().then((counts) => {
      expect(counts.import).toBe(1);
      const entries = db.getEntries(userId);
      expect(entries).toHaveLength(1);
      expect(entries[0].label).toBe('from the other machine');
      expect(entries[0].date).toBe(DATE);
      expect(db.getVersions(userId).entries).toBeGreaterThan(before);
      const row = db.getVaultIndex(notePath());
      expect(row.state).toBe('known');
      expect(row.rev).toBe(4);
      expect(row.verified).toBe(true);
    });
  });

  it('an unchanged file is skipped — the second pass never parses it', async () => {
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'first')], 4));
    await sync.scanVault();
    const after = db.getVaultIndex(notePath());
    const version = db.getVersions(userId).entries;

    // If the skip did not fire, this pass would re-import — and the ids staying put was once the
    // evidence that no parse reached the store. SB-117 has since made ids stable across a real
    // import too, so this assertion no longer distinguishes a skip from an import on its own; the
    // `counts.skip` and the un-bumped version below are what carry the claim now. Kept because a
    // skip must still not disturb an id, which is a weaker but real statement.
    const idsBefore = db.getEntries(userId).map((e) => e.id);
    const counts = await sync.scanVault();
    expect(counts.skip).toBe(1);
    expect(db.getEntries(userId).map((e) => e.id)).toEqual(idsBefore);
    expect(db.getVersions(userId).entries).toBe(version); // no bump, so no 409 against an open tab
    const now = db.getVaultIndex(notePath());
    expect(now.rev).toBe(after.rev);
    expect(now.seenAt >= after.seenAt).toBe(true); // it WAS looked at
  });

  it('TT’s own write does not come back as an import (the echo guard)', async () => {
    const md = note([entry('e1', 540, 600, 'typed here')], 2);
    writeFileSync(notePath(), md);
    // exactly what the writer does after a successful writeVaultFile
    sync.noteOwnWrite(notePath(), arb.fileSha(md), 2);
    const version = db.getVersions(userId).entries;
    const verdict = await sync.syncVaultPath(notePath(), DATE, sync.vaultSyncConfig(), { viaWatcher: true });
    expect(verdict).toBe('echo');
    expect(db.getEntries(userId)).toEqual([]); // nothing imported
    expect(db.getVersions(userId).entries).toBe(version); // and nothing to interrupt typing
  });

  it('an echo record does not hide a REAL change to the same path', async () => {
    // The guard is a de-duplication convenience (DD-009, DD-019 ruling 3) and must not become a
    // filter on the other machine's work.
    const mine = note([entry('e1', 540, 600, 'typed here')], 2);
    writeFileSync(notePath(), mine);
    sync.noteOwnWrite(notePath(), arb.fileSha(mine), 2);
    writeFileSync(notePath(), note([entry('e2', 600, 660, 'from over there')], 3));
    const verdict = await sync.syncVaultPath(notePath(), DATE, sync.vaultSyncConfig(), { viaWatcher: true });
    expect(verdict).toBe('import');
    expect(db.getEntries(userId).map((e) => e.label)).toEqual(['from over there']);
  });

  it('an unreadable file yields unknown and leaves the entries it already holds ALONE', async () => {
    // Invariant 1, which is the whole reason `unknown` is a state and not a comment.
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'three hours of real work')], 4));
    await sync.scanVault();
    expect(db.getEntries(userId)).toHaveLength(1);
    const version = db.getVersions(userId).entries;

    const counts = await sync.scanVault({
      readFile: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    });
    expect(counts.unknown).toBe(1);
    const entries = db.getEntries(userId);
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('three hours of real work');
    expect(db.getVersions(userId).entries).toBe(version);
    const row = db.getVaultIndex(notePath());
    expect(row.state).toBe('unknown');
    expect(row.rev).toBe(4); // what TT knew is not forgotten, only unconfirmed
  });

  it('a read that TIMES OUT does exactly the same thing', async () => {
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'three hours of real work')], 4));
    await sync.scanVault();
    const counts = await sync.scanVault({
      readFile: () => new Promise(() => {}), // never settles — the offline case SB-052 could not test
      timeoutMs: 20,
    });
    expect(counts.unknown).toBe(1);
    expect(db.getEntries(userId)).toHaveLength(1);
    expect(db.getVaultIndex(notePath()).state).toBe('unknown');
  });

  it('an absent file is unknown, never a deletion', async () => {
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'real work')], 4));
    await sync.scanVault();
    const verdict = await sync.syncVaultPath(join(dailyDir, '2026-07-19.md'), '2026-07-19', sync.vaultSyncConfig());
    expect(verdict).toBe('unknown');
    expect(db.getEntries(userId)).toHaveLength(1);
    expect(db.getVaultIndex(join(dailyDir, '2026-07-19.md')).state).toBe('unknown');
  });

  it('a DATALESS day is recorded unknown and performs ZERO reads', async () => {
    // A temp directory cannot be made dataless, so the stat is injected. What this pins is the
    // BRANCH — that classification decides before any read happens. The measurement that a real
    // evicted read costs ~1069 ms, and that 200 of them is a three-minute boot, lives in SB-052
    // and in task 1; it is not, and cannot be, in this file.
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'evicted')], 4));
    let reads = 0;
    const counts = await sync.scanVault({
      stat: () => ({ size: 19256, blocks: 0 }), // the real shape of an iCloud eviction
      readFile: (p) => {
        reads++;
        return Promise.resolve(readFileSync(p, 'utf8'));
      },
    });
    expect(reads).toBe(0);
    expect(counts.unknown).toBe(1);
    expect(db.getVaultIndex(notePath()).state).toBe('unknown');
    expect(db.getEntries(userId)).toEqual([]);
    // and a WARM stat of the same file does read it, so the assertion above is about the branch
    // and not about a scan that never runs
    let warmReads = 0;
    await sync.scanVault({
      stat: () => ({ size: 19256, blocks: 40 }),
      readFile: (p) => {
        warmReads++;
        return Promise.resolve(readFileSync(p, 'utf8'));
      },
    });
    expect(warmReads).toBe(1);
  });

  it('a quarantined note is left alone, recorded with its reason, and not re-parsed next pass', async () => {
    const damaged = note([entry('e1', 540, 600, 'first')], 4).replace('| 09:00→10:00 |', '| 09:15→10:00 |');
    writeFileSync(notePath(), damaged);
    const counts = await sync.scanVault();
    expect(counts.quarantine).toBe(1);
    const row = db.getVaultIndex(notePath());
    expect(row.state).toBe('quarantined');
    expect(row.quarantineReason).toBe('digest-mismatch');
    expect(readFileSync(notePath(), 'utf8')).toBe(damaged); // not one byte moved
    expect(db.getEntries(userId)).toEqual([]); // and nothing was imported out of it
    // STICKY, and that means the REASON too. The cheap `file_sha` exit re-puts the row without
    // re-deriving why it was refused, so a reason that is not preserved here renders on screen as
    // the generic "did not say why" line — a surface that has stopped telling the truth about a
    // note that has stopped syncing. Found by looking at it; pinned here.
    const first = db.getVaultIndex(notePath());
    expect((await sync.scanVault()).skip).toBe(1);
    const second = db.getVaultIndex(notePath());
    expect(second.state).toBe('quarantined');
    expect(second.quarantineReason).toBe('digest-mismatch');
    expect(second.quarantinedAt).toBe(first.quarantinedAt); // and it does not look newly broken
    // a note that RECOVERS carries no stale reason
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'repaired')], 5));
    expect((await sync.scanVault()).import).toBe(1);
    const third = db.getVaultIndex(notePath());
    expect(third.state).toBe('known');
    expect(third.quarantineReason).toBe(null);
    expect(third.quarantinedAt ?? null).toBe(null);
  });

  it('a rev regression TT cannot vouch for quarantines and never calls the rewriter', async () => {
    // The end-to-end shape of design decision 5(c), through the real engine rather than the pure
    // matrix: an index at rev 9 with no recorded previous pair, and a file claiming rev 3.
    let rewrites = 0;
    sync.setVaultRewriter(() => rewrites++);
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'restored from git')], 3));
    db.putVaultIndex({ path: notePath(), date: DATE, state: 'known', rev: 9, payloadDigest: 'aaaa', fileSha: 'x' });
    const counts = await sync.scanVault();
    expect(counts.quarantine).toBe(1);
    expect(rewrites).toBe(0);
    expect(db.getVaultIndex(notePath()).quarantineReason).toBe('unprovable-staleness');
  });

  it('a PROVABLY stale peer asks the writer to rewrite it, and imports nothing', async () => {
    // The other direction of the same split — without this a matrix that always quarantined would
    // look fine here too.
    let asked = null;
    sync.setVaultRewriter((date, rev) => (asked = { date, rev }));
    const behind = note([entry('e1', 540, 600, 'yesterday’s copy')], 3);
    writeFileSync(notePath(), behind);
    const digest = arb.describeVaultFile(behind, { heading: HEADING, date: DATE }).payloadDigest;
    db.putVaultIndex({ path: notePath(), date: DATE, state: 'known', rev: 3, payloadDigest: digest, fileSha: 'x' });
    db.putVaultIndex({ path: notePath(), date: DATE, state: 'known', rev: 4, payloadDigest: 'bbbb', fileSha: 'y' });
    const counts = await sync.scanVault();
    expect(counts['rewrite-from-index']).toBe(1);
    expect(asked).toEqual({ date: DATE, rev: 4 });
    expect(db.getEntries(userId)).toEqual([]); // the file's rows are TT's own older ones
  });

  it('pre-cutover days are not scanned at all (DD-016 applies to adoption, not only to writes)', async () => {
    db.db.exec("UPDATE settings SET value = '2026-07-15T09:00:00.000Z' WHERE key = 'vaultCutover'");
    writeFileSync(join(dailyDir, '2026-07-10.md'), note([entry('old', 540, 600, 'before TT')], 1, '2026-07-10'));
    writeFileSync(join(dailyDir, '2026-07-20.md'), note([entry('new', 540, 600, 'after TT')], 1));
    await sync.scanVault();
    expect(db.getEntries(userId).map((e) => e.label)).toEqual(['after TT']);
    expect(db.getVaultIndex(join(dailyDir, '2026-07-10.md'))).toBe(null); // never even looked at
  });

  it('an import replaces exactly its own day and leaves every other day untouched', async () => {
    // The write scope rule's read-side twin. This is the assertion that a whole-collection
    // `putEntries` did not quietly eat the days a scan skipped.
    db.putEntries(userId, [
      { ...entry('keep1', 480, 540, 'evicted monday'), date: '2026-07-13' },
      { ...entry('keep2', 480, 540, 'evicted tuesday'), date: '2026-07-14' },
    ]);
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'the day that moved')], 1));
    await sync.scanVault();
    const byDate = Object.fromEntries(db.getEntries(userId).map((e) => [e.date, e.label]));
    expect(byDate).toEqual({
      '2026-07-13': 'evicted monday',
      '2026-07-14': 'evicted tuesday',
      '2026-07-20': 'the day that moved',
    });
  });

  it('the watcher fires on a local change, and tears down without leaking a handle', { timeout: 30_000 }, async () => {
    // A LOCAL write only. This says nothing about an iCloud landing — see the header.
    expect(sync.startVaultSync({ debounceMs: 20, intervalMs: 3_600_000 })).toBe(true);
    // THE ARMING WINDOW, measured rather than guessed. `watch()` returns before macOS has actually
    // armed the FSEvents stream, so a write microseconds later races it and is silently missed:
    // without this pause the case failed 2 runs in 15 of the full suite — the watcher never
    // delivered at all, even given 20 s. With it, 0 in 25.
    //
    // PRODUCTION IS NOT EXPOSED TO THIS and does not need the pause: `startVaultSync` is followed
    // by a full `scanVault`, so a note written during the arming window is picked up by the scan,
    // and anything later by the interval. It is also a standing argument for that interval — an
    // fs.watch that can miss a LOCAL write is not one to bet an iCloud landing on.
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(notePath(), note([entry('e1', 540, 600, 'saved in Obsidian')], 1));
    // 20 s, and it is not padding: macOS delivers fs.watch through FSEvents, whose latency is not
    // bounded by anything Node controls. Measured on this machine the event is usually well under
    // 100 ms and occasionally seconds. That variance is itself why SB-057 specifies the slow
    // interval as a SECOND trigger rather than as belt and braces — and why no green here says
    // anything about an iCloud landing, which is a different code path again.
    const landed = await until(() => db.getEntries(userId).length === 1, { timeout: 20_000 });
    expect(landed, 'the watcher never delivered a locally-written note').toBe(true);
    expect(db.getEntries(userId)[0].label).toBe('saved in Obsidian');
    // idempotent start, then a clean stop — a handle leaked per settings change is invisible for
    // weeks on a detached `tt serve`
    expect(sync.startVaultSync({ debounceMs: 20, intervalMs: 3_600_000 })).toBe(true);
    sync.stopVaultSync();
    sync.stopVaultSync();
  });

  it('the fan-out runs AFTER the commit, not inside the transaction', async () => {
    // The blocker the end-gate review found. `store.putEntries` is called from inside
    // `store.transaction(...)` and the transaction CONTINUES afterwards — so a bare call would
    // fsync daily notes (and, once SB-068 lands, take a git checkpoint over the whole vault) while
    // nothing had committed.
    const path = notePath();
    let existedInsideTheTransaction = null;
    db.transaction(() => {
      store.putEntries(userId, [entry('e1', 540, 600, 'logged inside a transaction')]);
      existedInsideTheTransaction = existsSync(path);
    });
    expect(existedInsideTheTransaction, 'the note was written before the COMMIT').toBe(false);
    expect(existsSync(path), 'the note was never written after the COMMIT').toBe(true);
    expect(TT.parseVaultBlock(readFileSync(path, 'utf8'), { heading: HEADING, date: DATE }).entries).toHaveLength(1);
  });

  it('a ROLLBACK drops the fan-out entirely — no note describes an entry the index does not hold', () => {
    const path = notePath('2026-07-22');
    expect(() =>
      db.transaction(() => {
        store.putEntries(userId, [{ ...entry('e1', 540, 600, 'never committed'), date: '2026-07-22' }]);
        throw new Error('something later in the same transaction failed');
      }),
    ).toThrow('something later');
    expect(existsSync(path), 'a rolled-back save still wrote a daily note').toBe(false);
    expect(db.getEntries(userId).some((e) => e.date === '2026-07-22')).toBe(false);
  });

  it('the REAL rewriter corrects a provably stale peer, and the previous pair stays honest', async () => {
    // Until the end-gate review the rewrite path had no test at all — every case stubbed the
    // rewriter — so a second, divergent copy of the whole write path shipped unexercised.
    sync.setVaultRewriter((date, rev) => writer.rewriteVaultDate(userId, date, rev));
    // the index holds rev 4; the file on disk is the rev-3 payload TT itself wrote
    const behind = note([entry('e1', 540, 600, 'yesterday’s copy')], 3);
    writeFileSync(notePath(), behind);
    const digest3 = arb.describeVaultFile(behind, { heading: HEADING, date: DATE }).payloadDigest;
    db.putEntries(userId, [entry('e1', 540, 660, 'the current copy')]);
    db.putVaultIndex({ path: notePath(), date: DATE, state: 'known', rev: 3, payloadDigest: digest3, fileSha: 'x' });
    db.putVaultIndex({ path: notePath(), date: DATE, state: 'known', rev: 4, payloadDigest: 'bbbb', fileSha: 'y' });

    expect((await sync.scanVault())['rewrite-from-index']).toBe(1);
    const after = TT.parseVaultBlock(readFileSync(notePath(), 'utf8'), { heading: HEADING, date: DATE });
    expect(after.quarantine).toBe(false);
    expect(after.revision).toBe(4); // the arbitration's rev, not one derived from the stale file
    expect(after.entries.map((e) => e.end)).toEqual([660]); // the INDEX's rows, not the file's
    expect(db.getVaultIndex(notePath()).rev).toBe(4);
  });

  it('import-and-rewrite never records a (rev, digest) pair that no note carried', async () => {
    // The subtle one. `verdict.rev` is fileRev+1 while the digest is the payload AT fileRev, so
    // storing the two together fabricates a pair — and the rewriter then rolls that fabrication
    // into prev_*, after which `prevRev === rev` and branch (a) can never match again. A genuinely
    // stale peer would quarantine as `unprovable-staleness` instead of being caught up.
    sync.setVaultRewriter((date, rev) => writer.rewriteVaultDate(userId, date, rev));
    const edited = note([entry('e1', 540, 630, 'hand-edited without bumping')], 4);
    writeFileSync(notePath(), edited);
    const digest4 = arb.describeVaultFile(edited, { heading: HEADING, date: DATE }).payloadDigest;
    db.putVaultIndex({ path: notePath(), date: DATE, state: 'known', rev: 4, payloadDigest: 'aaaa', fileSha: 'x' });

    expect((await sync.scanVault())['import-and-rewrite']).toBe(1);
    const row = db.getVaultIndex(notePath());
    expect(row.rev).toBe(5); // rewritten
    expect(row.prevRev).toBe(4);
    expect(row.prevPayloadDigest).toBe(digest4); // the payload the file ACTUALLY carried at rev 4
    expect(row.prevRev).not.toBe(row.rev); // …so branch (a) is still reachable for this path
  });

  it('re-pointing the daily folder drops rows for the folder it left behind', async () => {
    // Otherwise a quarantine detected in the abandoned folder renders on Settings → Vault forever:
    // no scan visits that path again, so nothing can ever clear it.
    const damaged = note([entry('e1', 540, 600, 'first')], 4).replace('| 09:00→10:00 |', '| 09:15→10:00 |');
    writeFileSync(notePath(), damaged);
    await sync.scanVault();
    const orphan = notePath();
    expect(db.getVaultIndex(orphan).state).toBe('quarantined');

    const moved = join(vaultRoot, 'Notes', 'Days');
    mkdirSync(moved, { recursive: true });
    db.putSettings({ vaultPaths: { root: vaultRoot, daily: 'Notes/Days' } });
    expect(sync.startVaultSync({ debounceMs: 20, intervalMs: 3_600_000 })).toBe(true);
    expect(db.getVaultIndex(orphan), 'the abandoned folder’s row survived the re-point').toBe(null);
  });

  it('does nothing at all when no vault root is configured', async () => {
    db.putSettings({ vaultPaths: { root: '', daily: 'Calendar/Daily' } });
    expect(sync.vaultSyncConfig()).toBe(null);
    expect(await sync.scanVault()).toEqual({});
    expect(sync.startVaultSync()).toBe(false); // and emphatically does not scan from the cwd
  });
});

// ---- SB-117 / DD-019 ruling 3: an import preserves runtime ids ----
//
// WHAT THESE PROVE, and it is the actual contract: after an import, a row whose content did not
// change carries the SAME `entry.id` it carried before. `TimeGrid` keys its rows on that id, so a
// stable id is what stops the refresh after a 409 from remounting the whole day and destroying the
// `NoteCell` draft the user is typing into.
//
// WHAT THEY CANNOT PROVE: that a caret actually survives. These assert the id, which is the thing
// the contract is about; a caret surviving is a browser claim and no green run here is evidence for
// it. Named so nobody reads this block as the ergonomic verdict — that is SB-121's, and it is a
// feel-gate.
describe('an import preserves runtime ids (SB-117)', () => {
  const idOf = (rows, label) => rows.find((row) => row.label === label).id;

  it('keeps the ids of unchanged rows and mints a fresh one for the row that changed', async () => {
    writeFileSync(
      notePath(),
      note(
        [
          entry('a', 540, 600, 'morning stand-up'),
          entry('b', 600, 720, 'the actual work'),
          entry('c', 780, 840, 'code review'),
        ],
        4,
      ),
    );
    await sync.scanVault();
    const first = db.getEntries(userId);
    expect(first).toHaveLength(3);

    // the other machine moves ONE row's end time and bumps the revision
    writeFileSync(
      notePath(),
      note(
        [
          entry('a', 540, 600, 'morning stand-up'),
          entry('b', 600, 730, 'the actual work'), // 12:00 → 12:10
          entry('c', 780, 840, 'code review'),
        ],
        5,
      ),
    );
    expect((await sync.scanVault()).import).toBe(1);
    const second = db.getEntries(userId);
    expect(second).toHaveLength(3);

    expect(idOf(second, 'morning stand-up')).toBe(idOf(first, 'morning stand-up'));
    expect(idOf(second, 'code review')).toBe(idOf(first, 'code review'));
    // and the changed row is genuinely re-minted — a remount is CORRECT where the content moved
    expect(idOf(second, 'the actual work')).not.toBe(idOf(first, 'the actual work'));
    expect(second.find((row) => row.label === 'the actual work').end).toBe(730);
  });

  it('two identical rows on one day keep BOTH ids — matched in row order (DD-008 rule 9)', async () => {
    const twins = (revision, thirdLabel) =>
      note(
        [entry('p', 540, 570, 'triage'), entry('q', 540, 570, 'triage'), entry('r', 600, 660, thirdLabel)],
        revision,
      );
    writeFileSync(notePath(), twins(4, 'something else'));
    await sync.scanVault();
    const before = db.getEntries(userId);
    const twinIdsBefore = before.filter((row) => row.label === 'triage').map((row) => row.id);
    expect(twinIdsBefore).toHaveLength(2);
    expect(new Set(twinIdsBefore).size).toBe(2); // two rows, two distinct ids — never collapsed

    writeFileSync(notePath(), twins(5, 'something ELSE entirely')); // forces a real re-parse
    expect((await sync.scanVault()).import).toBe(1);
    const after = db.getEntries(userId);
    const twinIdsAfter = after.filter((row) => row.label === 'triage').map((row) => row.id);
    expect(new Set(twinIdsAfter)).toEqual(new Set(twinIdsBefore));
    expect(idOf(after, 'something ELSE entirely')).not.toBe(idOf(before, 'something else'));
  });

  it('a row REMOVED from the note frees nothing for the rows that remain', async () => {
    // The pool is drawn from, never re-used: a deleted row's id must not be handed to a row that
    // genuinely changed, which would make an edit look like a rename of something else.
    writeFileSync(notePath(), note([entry('a', 540, 600, 'kept'), entry('b', 600, 660, 'deleted')], 4));
    await sync.scanVault();
    const first = db.getEntries(userId);
    const deletedId = idOf(first, 'deleted');

    writeFileSync(notePath(), note([entry('a', 540, 600, 'kept'), entry('c', 600, 660, 'brand new')], 5));
    expect((await sync.scanVault()).import).toBe(1);
    const second = db.getEntries(userId);
    expect(idOf(second, 'kept')).toBe(idOf(first, 'kept'));
    expect(idOf(second, 'brand new')).not.toBe(deletedId);
  });

  it('a Mode-only change keeps the id — the recorded consequence of the index having no tags column', async () => {
    // NOT an accident, and NOT the ticket's contract being met by luck. `getEntries` returns no
    // `tags` (server/src/db.js says so in its own Omit), so the stored side of the comparison can
    // never carry a Mode value and `TT.entryMatchKey` leaves the slot out. The benign direction:
    // the row updates in place with its new tags instead of remounting. If a tags column ever lands
    // in SQLite, this expectation is the one that should flip — deliberately, not silently.
    const tagged = (revision, tags) => {
      const row = entry('a', 540, 600, 'deep work');
      if (tags) row.tags = tags;
      return note([row], revision);
    };
    writeFileSync(notePath(), tagged(4, ['#deep']));
    await sync.scanVault();
    const before = db.getEntries(userId);
    expect(before).toHaveLength(1);

    writeFileSync(notePath(), tagged(5, ['#admin']));
    expect((await sync.scanVault()).import).toBe(1);
    const after = db.getEntries(userId);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
  });
});

describe('TT.entryMatchKey (SB-117)', () => {
  const row = (over) => ({
    id: 'ignored',
    date: DATE,
    start: 540,
    end: 600,
    durMin: null,
    project: null,
    label: 'work',
    note: '',
    billable: true,
    ...over,
  });

  it('ignores the runtime id — that is the whole point', () => {
    expect(TT.entryMatchKey(row({ id: 'e1-abc' }))).toBe(TT.entryMatchKey(row({ id: 'e9-zzz' })));
  });

  it('separates the three time shapes and the empty cell (DD-008 rule 4)', () => {
    const keys = [
      TT.entryMatchKey(row({ start: 540, end: 600 })), // range
      TT.entryMatchKey(row({ start: 540, end: null })), // running
      TT.entryMatchKey(row({ start: null, end: null, durMin: 60 })), // duration
      TT.entryMatchKey(row({ start: null, end: null })), // none
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it('distinguishes every field it claims to carry', () => {
    const base = TT.entryMatchKey(row());
    for (const over of [
      { date: '2026-07-21' },
      { project: 'ACME' },
      { label: 'other' },
      { note: 'a note' },
      { billable: false },
    ])
      // prettier-ignore
      expect(TT.entryMatchKey(row(over)), JSON.stringify(over)).not.toBe(base);
  });

  it('trims label and note, because putEntries already did on the way in', () => {
    expect(TT.entryMatchKey(row({ label: '  work  ', note: ' hi ' }))).toBe(TT.entryMatchKey(row({ note: 'hi' })));
  });

  it('cannot be spoofed by moving text across the field boundary', () => {
    // Rule 3's U+001F join. A markdown cell cannot carry U+001F through TT's parser, so no typed
    // content can make two different rows key the same way.
    expect(TT.entryMatchKey(row({ label: 'a', note: 'b' }))).not.toBe(TT.entryMatchKey(row({ label: 'ab', note: '' })));
  });
});

/** Poll until the predicate holds, or give up. The watcher is debounced; a fixed sleep is a flake. */
async function until(predicate, { timeout = 5000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

// The write scope rule ITSELF, in isolation. The api suite above proves the OUTCOME — that a cold
// machine's unread days come out byte-identical — but that outcome is closed by `writeEligibility`
// as well, so a break in the scope rule alone would not show up there. This block is what makes
// the rule independently provable: it is the one function that decides which dates a save is even
// allowed to consider, and a folder glob is the failure it exists to refuse.
describe('the write scope rule (design decision 2)', () => {
  const on = (date) => ({ id: 'x' + date, date, start: 540, end: 600, durMin: null, project: null, label: '', note: '', billable: true }); // prettier-ignore
  const index = (states) => (date) => (states[date] ? { state: states[date] } : null);

  it('includes every date in the incoming set', () => {
    expect(writer.writeScope([on('2026-07-20'), on('2026-07-22')], [], index({}))).toEqual([
      '2026-07-20',
      '2026-07-22',
    ]);
  });

  it('includes a date that HAD entries, is now absent, and whose file TT has read — a real deletion', () => {
    const scope = writer.writeScope([on('2026-07-20')], [on('2026-07-20'), on('2026-07-21')], index({ '2026-07-21': 'known' })); // prettier-ignore
    expect(scope).toEqual(['2026-07-20', '2026-07-21']);
  });

  it('EXCLUDES a date TT has not confirmed reading, even though it had entries', () => {
    // `putEntries` is DELETE-all and the client PUTs everything it has, so an evicted day is simply
    // absent from the PUT. Reading that absence as "the day is now empty" writes a blank block over
    // hours TT never read — which is invariant 1 on the write side.
    for (const state of ['unknown', 'quarantined']) {
      expect(
        writer.writeScope([on('2026-07-20')], [on('2026-07-20'), on('2026-07-21')], index({ '2026-07-21': state })),
      ).toEqual([
        // prettier-ignore
        '2026-07-20',
      ]);
    }
    // and with no index row at all — TT has never even looked
    expect(writer.writeScope([on('2026-07-20')], [on('2026-07-20'), on('2026-07-21')], index({}))).toEqual([
      '2026-07-20',
    ]);
  });

  it('is never a folder glob: a date TT knows about but that this save does not mention is out of scope', () => {
    // The whole daily folder could be `known` and full of notes; a save that mentions none of them
    // touches none of them.
    const states = { '2026-07-18': 'known', '2026-07-19': 'known', '2026-07-21': 'known' };
    expect(writer.writeScope([on('2026-07-20')], [on('2026-07-20')], index(states))).toEqual(['2026-07-20']);
  });
});

// ## Verified red-green: 2026-07-26
// ## Verified red-green: 2026-07-27 (SB-117 — the four id-preservation cases go red with
//    `TT.preserveEntryIds` reverted out of `importEntries`; the spoofing case goes red with rule 3's
//    U+001F join replaced by an empty string)
