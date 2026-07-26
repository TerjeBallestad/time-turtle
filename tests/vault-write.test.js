// SB-057 task 6 — the writer, at the API rung.
//
// A REAL server process, `TT_SHAPE=personal`, a throwaway data dir and a throwaway vault, driven
// over HTTP with a cookie jar. Nothing here asserts on a 200: the SQLite write has already
// committed by the time a vault byte is written, so a 200 says nothing at all about the vault.
// Every claim below is either bytes on disk or those bytes read back through `TT.parseVaultBlock`.
//
// Running this without `TT_SHAPE=personal` would make every assertion pass VACUOUSLY against the
// sqlite path, so the shape is asserted on the wire before anything else is.
//
// What a green run here does NOT prove: that any of it works across two machines, or through
// iCloud, or on a cold vault. See the honesty clause on SB-057 and the gate ticket task 9 files.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn } from './util.js';

const HEADING = 'Time Log';
/** Dates are relative to today, because `vaultCutover` is stamped at first boot. */
const TODAY = TT.todayStr();
const TOMORROW = TT.addDays(TODAY, 1);

const entry = (id, date, start, end, label) => ({
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

/** Poll: the vault fan-out happens inside the save, but the save is over HTTP. */
async function until(predicate, { timeout = 5000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

describe('the vault writer (api)', () => {
  let vault = '';
  let dailyDir = '';
  let admin = null;
  let child = null;
  const notePath = (date) => join(dailyDir, date + '.md');
  const parseNote = (date) => TT.parseVaultBlock(readFileSync(notePath(date), 'utf8'), { heading: HEADING, date });

  beforeAll(async () => {
    const data = mkdtempSync(join(tmpdir(), 'tt-vw-data-'));
    vault = mkdtempSync(join(tmpdir(), 'tt-vw-vault-'));
    dailyDir = join(vault, 'Calendar', 'Daily');
    mkdirSync(dailyDir, { recursive: true });
    const server = await startServer({ TT_DATA_DIR: data, TT_SHAPE: 'personal', TT_SEED_DEMO: '0' });
    child = server.child;
    admin = await adminOn(server.port);
    const state = await admin('GET', '/api/state');
    // the shape, asserted on the wire — without it every assertion below is vacuous
    expect(state.json.shape).toBe('personal');
    expect(state.json.settings.vaultCutover).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // ONLY `vaultPaths`. Echoing the whole settings object back would store `shape: 'team'` —
    // `getSettings().shape` DEFAULTS to team when nothing is stored, even on an install whose
    // EFFECTIVE shape is `personal` via TT_SHAPE — and a stored setting beats the env. That is a
    // real hazard on the client's whole-object PUT and is reported separately; it is not what this
    // suite is about, and a partial settings PUT has always been legal (`putSettings` writes only
    // the keys it is given).
    const put = await admin('PUT', '/api/state', {
      settings: { vaultPaths: { root: vault, daily: 'Calendar/Daily' } },
      version: state.json.version,
    });
    expect(put.status).toBe(200);
    expect((await admin('GET', '/api/state')).json.shape).toBe('personal');
  });
  afterAll(async () => {
    if (child) await stopServer(child);
    stopAllServers();
  });

  /** PUT an entry set, always with a fresh version so a bump from an import cannot 409 us. */
  async function save(entries) {
    const state = await admin('GET', '/api/state');
    const res = await admin('PUT', '/api/state', { entries, version: state.json.version });
    expect(res.status).toBe(200);
    return res;
  }

  it('a save writes real daily notes that TT’s own parser reads back as the entries saved', async () => {
    await save([
      entry('a1', TODAY, 540, 600, 'today’s hour'),
      entry('a2', TOMORROW, 600, 660, 'tomorrow’s hour'),
      entry('a3', TT.addDays(TODAY, 2), 660, 720, 'the day after'),
    ]);
    for (const [date, label] of [
      [TODAY, 'today’s hour'],
      [TOMORROW, 'tomorrow’s hour'],
      [TT.addDays(TODAY, 2), 'the day after'],
    ]) {
      expect(existsSync(notePath(date)), `no note for ${date}`).toBe(true);
      const parsed = parseNote(date);
      expect(parsed.quarantine).toBe(false);
      expect(parsed.entries.map((e) => e.label)).toEqual([label]);
      expect(parsed.verified).toBe(true); // TT always writes a digest (DD-009)
      expect(parsed.revision).toBe(1); // a first write starts at 1 (DD-012)
    }
  });

  it('(1) a second IDENTICAL save writes no file at all', async () => {
    // Without the diff, one keystroke rewrites every daily note the user has ever logged — a
    // per-keystroke storm through iCloud, and the thing most likely to make SB-046 come back "no".
    const before = [TODAY, TOMORROW].map((d) => statSync(notePath(d)).mtimeMs);
    await save([
      entry('a1', TODAY, 540, 600, 'today’s hour'),
      entry('a2', TOMORROW, 600, 660, 'tomorrow’s hour'),
      entry('a3', TT.addDays(TODAY, 2), 660, 720, 'the day after'),
    ]);
    await new Promise((r) => setTimeout(r, 60));
    expect([TODAY, TOMORROW].map((d) => statSync(notePath(d)).mtimeMs)).toEqual(before);
    // and the revision did not creep either — a bump per keystroke would make every peer's
    // arbitration input churn for no reason
    expect(parseNote(TODAY).revision).toBe(1);
  });

  it('(2) an entry dated BEFORE the cutover produces no file and no adoption', async () => {
    // DD-016's hazard, exactly: `TT.seedMd()` dates its demo entries relative to first boot — `T`,
    // `T-1`, `T-2`, `T-7`, `T-8`, `T-9` — so without this a fresh personal install adopts six of
    // Terje's real daily notes and writes Fjellheim AS hours into them.
    //
    // BOTH DIRECTIONS, because they are protected by different code and only one of them is
    // protected by `TT.vaultBound`:
    //   (a) a pre-cutover day whose note EXISTS — untouched, and no anchor inserted;
    //   (b) a pre-cutover day whose note does NOT exist — and no note is created. This is the one
    //       the filter itself has to catch: an absent note is otherwise eligible to be written,
    //       because creating a file loses nothing.
    const old = TT.addDays(TODAY, -30);
    const older = TT.addDays(TODAY, -31); // (b): deliberately no note on disk
    // a REAL daily note of Terje's, adoptable on its face: it carries the heading and a
    // well-formed table, which is exactly what DD-012 adoption fires on
    const his = `# ${old}\n\n## ${HEADING}\n\n| Time | Task |\n|---|---|\n| 08:00→09:00 | his own morning |\n\n## Captures\n\nmine\n`;
    writeFileSync(notePath(old), his);
    expect(existsSync(notePath(older))).toBe(false);
    await save([
      entry('a1', TODAY, 540, 600, 'today’s hour'),
      entry('old', old, 480, 540, 'pre-cutover'),
      entry('older', older, 480, 540, 'pre-cutover, no note'),
    ]);
    await new Promise((r) => setTimeout(r, 150));
    expect(readFileSync(notePath(old), 'utf8')).toBe(his); // not one byte, and no anchor inserted
    expect(readFileSync(notePath(old), 'utf8')).not.toContain('revision:');
    expect(existsSync(notePath(older)), 'a pre-cutover day was given a daily note').toBe(false);
    // …and both DID reach SQLite, because a non-vault-bound entry is skipped for the vault, never
    // refused — a 403 here would be a permanent 4 s toast loop in `useServerSync`
    const state = await admin('GET', '/api/state');
    expect(state.json.entries.map((e) => e.id).sort()).toEqual(['a1', 'old', 'older']);
  });

  it('(3) deleting the last entry on a date rewrites that note with an EMPTY block', async () => {
    // Not a deleted file (the note is Terje's, and his other sections are in it) and not an
    // untouched one (the hours really are gone). The block stays, with its header row: no header
    // means no schema.
    await save([entry('a1', TODAY, 540, 600, 'today’s hour'), entry('a2', TOMORROW, 600, 660, 'tomorrow’s hour')]);
    expect(parseNote(TOMORROW).entries).toHaveLength(1);
    const revBefore = parseNote(TOMORROW).revision;
    await save([entry('a1', TODAY, 540, 600, 'today’s hour')]);
    expect(await until(() => parseNote(TOMORROW).entries.length === 0)).toBe(true);
    expect(existsSync(notePath(TOMORROW))).toBe(true);
    const parsed = parseNote(TOMORROW);
    expect(parsed.quarantine).toBe(false);
    expect(parsed.entries).toEqual([]);
    expect(readFileSync(notePath(TOMORROW), 'utf8')).toContain('| Time | Mode | Project | Task | Bill |');
    expect(parsed.revision).toBe(revBefore + 1); // a real write, so the counter moved
  });

  it('(4) a date TT has NOT confirmed reading is never written — even when absent from the PUT', async () => {
    // The failure the write scope rule exists to prevent, in the shape the orchestrator named:
    // a cold machine with several days TT has never read, and a user saving one entry.
    //
    // `putEntries` is DELETE-all and the client PUTs everything it has, so those days are simply
    // ABSENT from the PUT. A writer that read absence as "the day is now empty" would write a
    // blank block over hours it had never even read.
    const evicted = [TT.addDays(TODAY, 10), TT.addDays(TODAY, 11), TT.addDays(TODAY, 12)];
    const bytes = {};
    for (const date of evicted) {
      const md = `# ${date}\n\n## Intentions\n\nreal work\n\n${TT.serializeVaultBlock(
        [entry('x', date, 480, 600, 'two hours nobody imported')],
        { heading: HEADING, revision: 9 },
      )}\n\n## Captures\n\nnotes\n`;
      writeFileSync(notePath(date), md);
      bytes[date] = md;
    }
    await save([entry('a1', TODAY, 540, 615, 'today’s hour, edited')]);
    await new Promise((r) => setTimeout(r, 200));
    for (const date of evicted) {
      expect(readFileSync(notePath(date), 'utf8'), `${date} was rewritten`).toBe(bytes[date]);
    }
    // the save that provoked it DID land, so this is not a writer that simply stopped
    expect(parseNote(TODAY).entries[0].end).toBe(615);
  });

  it('a quarantined note is left byte-identical and never fails the save', async () => {
    // SB-065's posture, in the vault: the SQLite write has already committed, so a note-level
    // refusal is reported, never promoted to a 500.
    const date = TT.addDays(TODAY, 3);
    const damaged = `# ${date}\n\n## ${HEADING}\n\nsomething Terje typed under the heading\n\n\`revision: 4 · abcd\`\n`;
    writeFileSync(notePath(date), damaged);
    const res = await save([entry('a1', TODAY, 540, 615, 'today’s hour, edited'), entry('q', date, 480, 540, 'never lands')]); // prettier-ignore
    expect(res.status).toBe(200); // the save succeeded…
    await new Promise((r) => setTimeout(r, 150));
    expect(readFileSync(notePath(date), 'utf8')).toBe(damaged); // …and the note is untouched
  });

  it('no temp files are left in the daily folder', () => {
    // Every write goes through the atomic primitive, and the primitive cleans up after itself.
    expect(readdirSync(dailyDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('an external write is imported, and re-pointing the vault folder re-points the engine', async () => {
    // Task 5's boot/settings wiring, proven where it actually matters: through a real server. A
    // unit test cannot show that configuring the vault folder in Settings starts the engine, and
    // without that the whole feature is plumbing nobody can reach.
    const second = mkdtempSync(join(tmpdir(), 'tt-vw-vault2-'));
    const secondDaily = join(second, 'Calendar', 'Daily');
    mkdirSync(secondDaily, { recursive: true });
    const day = TT.addDays(TODAY, 5); // AFTER the cutover — a pre-cutover day is correctly ignored
    const md = `# ${day}\n\n${TT.serializeVaultBlock([entry('other', day, 600, 720, 'written on the laptop')], {
      heading: HEADING,
      revision: 3,
    })}\n`;
    writeFileSync(join(secondDaily, day + '.md'), md);

    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      settings: { vaultPaths: { root: second, daily: 'Calendar/Daily' } },
      version: state.json.version,
    });
    expect(put.status).toBe(200);
    let imported = null;
    for (let i = 0; i < 100 && !imported; i++) {
      const now = await admin('GET', '/api/state');
      imported = now.json.entries.find((e) => e.label === 'written on the laptop') || null;
      if (!imported) await new Promise((r) => setTimeout(r, 50));
    }
    expect(imported, 'the entry from the re-pointed vault never arrived').toBeTruthy();
    expect(imported.date).toBe(day);
  });
});

// ## Verified red-green: 2026-07-26
