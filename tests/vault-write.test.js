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
  let dataDir = '';
  const notePath = (date) => join(dailyDir, date + '.md');
  const parseNote = (date) => TT.parseVaultBlock(readFileSync(notePath(date), 'utf8'), { heading: HEADING, date });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tt-vw-data-'));
    const data = dataDir;
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

  it('vaultQuarantined is gated on the SHAPE, not merely empty by accident under team', async () => {
    // Every other field in `stateFor` is stripped, user-scoped or admin-gated. This one carries
    // absolute filesystem paths of the vault owner's daily notes, and under `team` it was empty
    // only because nothing writes `vault_index` there — not because anything checked. A
    // `personal → team` switch leaves those rows behind.
    // Trip a real quarantine through the SCAN (the writer refuses an unread note without
    // quarantining it, which is a different verdict) and re-point the vault to force a pass.
    const q = TT.addDays(TODAY, 7);
    writeFileSync(notePath(q), `# ${q}\n\n## ${HEADING}\n\nprose, not a table\n\n\`revision: 2 · abcd\`\n`);
    const before = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', {
      settings: { vaultPaths: { root: vault, daily: 'Calendar/Daily' } },
      version: before.json.version,
    });
    const tripped = await until(async () => {
      const now = await admin('GET', '/api/state');
      return (now.json.vaultQuarantined || []).length > 0;
    });
    expect(tripped, 'no quarantine was recorded to test the gate with').toBe(true);
    const state = await admin('GET', '/api/state');
    expect(state.json.shape).toBe('personal');

    // a SECOND server, same data dir, booted as `team` — the rows are still in the DB
    const teamServer = await startServer({ TT_DATA_DIR: dataDir, TT_SHAPE: 'team', TT_SHAPE_LOCK: '1', TT_SEED_DEMO: '0' }); // prettier-ignore
    try {
      const teamAdmin = await adminOn(teamServer.port);
      const teamState = await teamAdmin('GET', '/api/state');
      expect(teamState.json.shape).toBe('team');
      expect(teamState.json.vaultQuarantined, 'a team install handed out vault paths').toEqual([]);
    } finally {
      await stopServer(teamServer.child);
    }
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
//
// ## Verified red-green: 2026-07-27
// PLAN-015 (SB-102 / DD-017 §2): the frozen-segment case below. Output TRANSCRIBED from the run.
//   `TT.frozenSegment` forced to `return false` in shared/core.js — the ledger clause gone,
//   the cutover clause untouched. Both new cases fail, and they fail on the POST-cutover day,
//   which is the half the date clause cannot reach:
//     × writes no note for ANY day of a frozen segment — including the ones after the cutover
//       AssertionError: a POST-cutover day of a frozen segment got a note: 2026-07-27:
//       expected true to be false
//     × does not ADOPT a frozen segment’s post-cutover note either, when one already exists
//       AssertionError: expected '# 2026-07-27\n\n## Time Log\n\n| Time…' to be
//       '# 2026-07-27\n\n## Time Log\n\n| Time…'   (the note was rewritten with TT's own block)
//   The CONTRAST half — the uncommitted post-cutover day's note — stays green throughout, which
//   is what makes the absences above mean something rather than "the writer was broken".
//   Restored: 11 passed.

// ---------------------------------------------------------------------------
// DD-017 §2 — A COMMITTED SEGMENT NEVER SPLITS: the ledger wins over the date.
//
// PLAN-015 pays a coverage debt, not a code debt. `server/src/vault-write.js` has filtered
// through `TT.vaultBound` since PLAN-012, and `vaultBound`'s third clause — a day inside a
// committed segment is not the vault's, EVEN WHEN IT IS AFTER THE CUTOVER — had never been
// executed by a test in either direction (`grep -rn vaultBound tests/` returned one comment).
// Case (2) above proves only the cutover clause, where the date alone already decides.
//
// The discriminating pair, and it is the whole design of this case:
//   • days of a COMMITTED segment that fall AFTER the cutover  → no daily note. Only the ledger
//     clause can produce this; a build with the ledger clause removed writes them happily.
//   • a day that is also after the cutover but in NO committed segment → a note IS written.
// Without the second half the first proves nothing: a writer that was simply broken, or a vault
// path that never took, produces exactly the same absence.
//
// The segment has to be committed while `team` and met while `personal`, because `personal`
// refuses a ledger CHANGE (SB-056/DD-008) — so this is a team boot, a stop, and a personal boot
// on the same data dir, which is also the only install shape that can reach this state for real.
describe('the vault writer: a committed segment stays whole (DD-017 §2)', () => {
  let vault = '';
  let dailyDir = '';
  let admin = null;
  let child = null;
  let segment = null;
  const notePath = (date) => join(dailyDir, date + '.md');
  const ENTRIES = [];

  beforeAll(async () => {
    const data = mkdtempSync(join(tmpdir(), 'tt-vw2-data-'));
    const md = join(data, 'mirror');
    vault = mkdtempSync(join(tmpdir(), 'tt-vw2-vault-'));
    dailyDir = join(vault, 'Calendar', 'Daily');
    mkdirSync(dailyDir, { recursive: true });

    // The segment containing today. Its days after today are post-cutover once the personal boot
    // stamps the cutover at "now"; today itself always qualifies, so the post-cutover half of
    // this segment is never empty whatever weekday the suite runs on.
    segment = TT.weekSegments(TODAY).find((seg) => seg.dates.includes(TODAY));
    const control = TT.addDays(TODAY, 7); // a different ISO week, so a genuinely uncommitted segment
    let n = 0;
    for (const date of segment.dates) ENTRIES.push(entry('seg' + n++, date, 540, 600, 'in the frozen segment'));
    ENTRIES.push(entry('control', control, 660, 720, 'after the cutover and in no ledger'));

    // BOOT 1 — `team`, where a commit is legal.
    const team = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SEED_DEMO: '0' });
    const teamAdmin = await adminOn(team.port);
    const before = await teamAdmin('GET', '/api/state');
    expect(before.json.shape).toBe('team');
    const seeded = await teamAdmin('PUT', '/api/state', {
      entries: ENTRIES,
      commits: [{ key: segment.key }],
      version: before.json.version,
    });
    expect(seeded.status).toBe(200);
    expect((await teamAdmin('GET', '/api/state')).json.commits.map((c) => c.key)).toEqual([segment.key]);
    await stopServer(team.child);

    // BOOT 2 — `personal`, which stamps the cutover at first personal boot (DD-016).
    const personal = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal', TT_SEED_DEMO: '0' });
    child = personal.child;
    admin = await adminOn(personal.port);
    const state = await admin('GET', '/api/state');
    expect(state.json.shape).toBe('personal'); // without this every assertion below is vacuous
    // Stamped at THIS boot, so it is today's instant — but deliberately not asserted equal to
    // `TODAY`: the stamp is an ISO instant in UTC and `TT.todayStr()` is a LOCAL day, so the two
    // disagree for a couple of hours a night east of Greenwich. Every day-grained comparison
    // below derives `cutoverDay` from the stamp itself rather than assuming which one it is.
    // (That skew is a real pre-existing defect in DD-016's stamp and is filed separately; it is
    // not this case's subject and this case must not depend on which side of it we run.)
    expect(state.json.settings.vaultCutover).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.json.commits.map((c) => c.key)).toEqual([segment.key]); // the pre-switch ledger survived
    const put = await admin('PUT', '/api/state', {
      settings: { vaultPaths: { root: vault, daily: 'Calendar/Daily' } },
      version: state.json.version,
    });
    expect(put.status).toBe(200);
  }, 90000);
  afterAll(async () => {
    if (child) await stopServer(child);
    stopAllServers();
  });

  it('writes no note for ANY day of a frozen segment — including the ones after the cutover', async () => {
    // A real save under `personal`: every entry changed, so nothing here can be the identity
    // diff of case (1) declining to write.
    const state = await admin('GET', '/api/state');
    const res = await admin('PUT', '/api/state', {
      entries: ENTRIES.map((e) => ({ ...e, end: e.end + 15 })),
      version: state.json.version,
    });
    expect(res.status).toBe(200);

    const cutoverDay = state.json.settings.vaultCutover.slice(0, 10);
    const postCutover = segment.dates.filter((date) => date >= cutoverDay);
    const preCutover = segment.dates.filter((date) => date < cutoverDay);
    // THE LOAD-BEARING GUARD. If this set is empty the case is vacuous — every remaining
    // assertion would be satisfied by the cutover clause alone and a build with no ledger
    // clause at all would pass.
    expect(postCutover.length, 'no post-cutover day in the committed segment — the case is vacuous').toBeGreaterThan(0);

    // THE CONTRAST: an uncommitted post-cutover day IS written. Wait on it rather than on a
    // sleep, and assert it FIRST — it is what makes the absences below mean something.
    expect(await until(() => existsSync(notePath(TT.addDays(TODAY, 7))))).toBe(true);
    const written = TT.parseVaultBlock(readFileSync(notePath(TT.addDays(TODAY, 7)), 'utf8'), {
      heading: HEADING,
      date: TT.addDays(TODAY, 7),
    });
    expect(written.quarantine).toBe(false);
    expect(written.entries.map((e) => e.label)).toEqual(['after the cutover and in no ledger']);

    await new Promise((r) => setTimeout(r, 150)); // let any stray write land before claiming absence
    for (const date of postCutover)
      expect(existsSync(notePath(date)), `a POST-cutover day of a frozen segment got a note: ${date}`).toBe(false);
    for (const date of preCutover)
      expect(existsSync(notePath(date)), `a pre-cutover day of a frozen segment got a note: ${date}`).toBe(false);

    // …and all of them are in SQLite. A frozen segment is SKIPPED for the vault, never refused —
    // the entries are still the user's hours and still have to come back on the wire.
    const after = await admin('GET', '/api/state');
    expect(after.json.entries.map((e) => e.id).sort()).toEqual(ENTRIES.map((e) => e.id).sort());
    const wanted = new Map(ENTRIES.map((e) => [e.id, e.end + 15]));
    for (const stored of after.json.entries) expect(stored.end, stored.id).toBe(wanted.get(stored.id));
  }, 30000);

  it('does not ADOPT a frozen segment’s post-cutover note either, when one already exists', async () => {
    // The other direction of case (2)'s (a)/(b) split, at the ledger clause: a real note on a
    // post-cutover day inside the frozen segment is adoptable on its face — heading, well-formed
    // table — and DD-012 adoption must still not fire on its behalf.
    const cutoverDay = (await admin('GET', '/api/state')).json.settings.vaultCutover.slice(0, 10);
    const day = segment.dates.filter((date) => date >= cutoverDay)[0];
    const his = `# ${day}\n\n## ${HEADING}\n\n| Time | Task |\n|---|---|\n| 08:00→09:00 | his own morning |\n\n## Captures\n\nmine\n`;
    writeFileSync(notePath(day), his);
    const state = await admin('GET', '/api/state');
    const res = await admin('PUT', '/api/state', {
      entries: ENTRIES.map((e) => ({ ...e, end: e.end + 30 })),
      version: state.json.version,
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(notePath(day), 'utf8')).toBe(his); // not one byte, and no anchor inserted
    expect(readFileSync(notePath(day), 'utf8')).not.toContain('revision:');
    const after = await admin('GET', '/api/state');
    expect(after.json.entries.some((e) => e.label === 'his own morning')).toBe(false);
  }, 30000);
});
