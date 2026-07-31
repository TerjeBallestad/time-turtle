// PLAN-013 / SB-115 / DD-018: THE BOOT BANNER, on the env path where nobody is in the room.
//
// `server/src/index.js` stamps the cutover and retires the mirror files at boot with no human
// present — that is the whole reason the sweep exists ("an install switched by `TT_SHAPE=personal`
// alone never fires a settings write"). DD-018 keeps that path UNGATED on purpose: you cannot ask
// a boot, and an env var is the operator's answer. But it owes the same sentences, because an
// env-switched install is precisely the one where nobody was there at the moment of STRANDING.
//
// ORDERING IS THE RULE, and it is SB-115's own words: ENTRIES FIRST, FILES LAST. The two stranding
// lines go between the cutover stamp and `retireMirrors()`, which is what makes the order true
// where the per-file retirement lines already print, at module top level. The `app.listen` banner
// is NOT touched — DD-018's mock is abbreviated, and the composite `api on … · shape: … ·
// storage: …` line is SB-073's.
//
// WHAT THIS FILE CANNOT PROVE: that the sentences read right to a human. That is the `terje` rung
// and it is delivered as a gate ticket, never asserted here. Everything below is arithmetic and
// order.
//
// NO LITERAL COUNTS ANYWHERE. Every number is parsed back OUT of the banner line and compared to
// what that same data dir's own SQLite says, re-derived through `TT.vaultBound` — the predicate
// the real write filter uses.
//
// ## Verified red-green: 2026-07-27 (output TRANSCRIBED from the runs, not reconstructed)
//
//   Green baseline: 6 of 6. The first run of this file against a server with no banner was red on
//   5 of 6 — `AssertionError: no stranding line in:` with the whole boot log attached — and the
//   sixth (the `team` boot) was green then and stays green now, correctly: there is nothing for a
//   team boot to get wrong. Each mutation below was applied to server/src/index.js alone.
//
//   B1 — the retirement block moved ABOVE the SB-100 boot block, i.e. FILES FIRST, ENTRIES LAST.
//   1 of 6, and only the order test:
//     FAIL  says what it stranded BEFORE what it retired — entries first, files last
//           AssertionError: expected 479 to be less than 0
//
//   B2 — `entries.count + 1`. 4 of 6, which is what "no literal counts anywhere" buys:
//     FAIL  prints the stranding lines, with the numbers this data dir actually holds
//     FAIL  a SECOND boot of the same dir reports the same cutover (first-stamp-wins)
//     FAIL  a personal → team → personal round trip does not count the team interlude
//           AssertionError: expected 11 to be 10 // Object.is equality  (all three)
//     FAIL  an install with nothing to strand stays quiet, and still retires
//           AssertionError: expected '[time-turtle] vault cutover: 2026-07-…' not to match
//                           /\[time-turtle\]\s+(\d+) entr(?:y|ies)…/
//   The last one is the off-by-one turning 0 into 1 and breaking the silence, which is a second
//   real symptom of the same bug rather than a duplicate of the first three.
//
//   B3 — the total line dropped (`retireMirrors()` back to a bare call). 2 of 6:
//     FAIL  says what it stranded BEFORE what it retired — entries first, files last
//           AssertionError: retired in total line missing from: …
//     FAIL  an install with nothing to strand stays quiet, and still retires
//
//   B4 — the `count > 0 || segments > 0` silence guard dropped. 1 of 6, and only the quiet one:
//     FAIL  an install with nothing to strand stays quiet, and still retires
//           AssertionError: expected '[time-turtle] vault cutover: 2026-07-…' not to match …
//
//   B5 — the whole block un-gated from `target.shape === 'personal'`, so a `team` boot prints it.
//   1 of 6, and only the team one:
//     FAIL  a `team` boot says nothing about stranding at all
//           AssertionError: expected '[time-turtle] vault cutover:  — entri…' not to match …
//
//   ONE HONEST LIMIT. The `strandedAt < rangeAt` assertion is text order WITHIN one boot's stdout
//   and would still pass if both lines came out of a single `console.log`. It is not the
//   load-bearing claim; ENTRIES-BEFORE-FILES is, it spans separate calls, and B1 fails it.
//
//   ---- the end-gate review round (maker != checker), green baseline 8 of 8 ----
//
//   BOTH review axes independently found the same defect in the sentence this file gates, and it
//   was live in the first cut. Two fixes to the shipped wording, each now gated:
//
//   (a) THE COUNT IS NOT "ENTRIES DATED BEFORE IT". It is the complement of `TT.vaultBound` — the
//       date clause OR DD-017's ledger clause — so a committed POST-cutover day is stranded too
//       and `last` can be later than the cutover printed on the line above. The old sentence
//       asserted a date relation its own number did not have, next to a range that contradicted
//       it. The clause is gone; the cutover line above still carries the date rule.
//   (b) "0 ENTRIES … WITH THEM". The guard was `count > 0 || segments > 0` with the entries line
//       unconditional inside it, so a committed segment holding no entries printed a loss
//       announcement with nothing lost, referring to an empty set. Silence is now `count === 0`.
//       This NARROWS the plan's stated condition, deliberately — the plan's own condition is what
//       produced the sentence.
//
//   R2 — the freeze clause appended unconditionally. 1 of 8:
//     FAIL  with nothing committed, the range line stands alone — no freeze clause
//           AssertionError: expected '; 0 commit segments freeze with them' to be ''
//   R3 — silence back to `count === 0 && segments === 0`. 1 of 8:
//     FAIL  an install with nothing to strand stays quiet, and still retires
//           AssertionError: expected '[time-turtle] vault cutover: 2026-07-…' not to match …
//   B1 RE-RUN after the refactor (composition moved into shape-preflight.js's
//   `strandingBannerLines`, emission still one console.log per line here): 1 of 8,
//     FAIL  says what it stranded BEFORE what it retired — entries first, files last
//           AssertionError: expected 463 to be less than 0
//   — so moving the composition did not cost the ordering instrument.
//
//   Two branches that shipped untested and now are not: `segments === 0` (range line alone) and a
//   committed post-cutover week (the DD-017 case, which only the preflight suite had).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, md: join(data, 'mirror') };
}

/** Poll: `startServer` resolves when /api/me answers, which can beat a banner line. */
async function until(predicate, { timeout = 8000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

// ---- that same data dir's own truth, with the server stopped ----

function openDb(data) {
  return new DatabaseSync(join(data, 'timeturtle.db'), { readOnly: true });
}

function storedSetting(data, key) {
  const db = openDb(data);
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } finally {
    db.close();
  }
}

/** What the banner's two numbers MUST be, re-derived from the dir rather than remembered. */
function expectedFromDb(data, userId) {
  const db = openDb(data);
  try {
    const cutover = storedSetting(data, 'shapeStamp');
    const commitRow = db.prepare('SELECT data FROM commits WHERE user_id = ?').get(userId);
    const commits = commitRow ? JSON.parse(commitRow.data) : [];
    const entries = db
      .prepare('SELECT id, date, start, end, project, label, note, billable FROM entries WHERE user_id = ?')
      .all(userId)
      .map((row) => ({ ...row, billable: !!row.billable }));
    const ctx = { shape: 'personal', cutover: cutover, commits };
    const stranded = entries.filter((entry) => !TT.vaultBound(entry, ctx));
    const dates = stranded.map((e) => e.date).sort();
    return {
      cutover,
      count: stranded.length,
      first: dates[0] ?? null,
      last: dates[dates.length - 1] ?? null,
      segments: commits.length,
    };
  } finally {
    db.close();
  }
}

// ---- reading the banner back ----

const STRANDED_RE = /\[time-turtle\]\s+(\d+) entr(?:y|ies) stays? in SQLite and never reach(?:es)? the vault/;
// The range, with the freeze clause OPTIONAL — an install with nothing committed prints the range
// alone, and asserting the clause unconditionally would have left that branch untested.
const RANGE_RE = /\[time-turtle\]\s+\((\d{4}-\d{2}-\d{2}) … (\d{4}-\d{2}-\d{2})\)(.*)/;
const FROZEN_RE = /^; (\d+) commit segments? freezes? with them$/;
const TOTAL_RE = /\[time-turtle\] (\d+) mirror files? retired in total/;
const CUTOVER_RE = /\[time-turtle\] shape stamp: (\S+) —/;

const entry = (id, date, label = 'work') => ({
  id,
  date,
  start: 540,
  end: 600,
  project: null,
  label,
  note: '',
  billable: 1,
});

/**
 * A `team` install carrying entries on both sides of the cutover a later `personal` boot will
 * stamp, plus a mirror file on disk for that boot to retire. Returns with the server stopped.
 *
 * `PAST` is 2020 rather than "yesterday" because the cutover is a UTC instant and `TT.todayStr()`
 * is a LOCAL day; adjacent days can disagree by one in either direction (SB-143).
 */
const PAST = '2020-01-01';
const FUTURE = '2099-01-01';

async function seededTeamDir(label) {
  const { data, md } = dataDir(label);
  const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
  const admin = await adminOn(server.port);
  const userId = (await admin('GET', '/api/me')).json.user.id;
  const state = await admin('GET', '/api/state');
  // A save under `team` also writes the mirror file, so the later personal boot has one to retire.
  expect(
    (
      await admin('PUT', '/api/state', {
        entries: [...state.json.entries, entry('past-1', PAST), entry('past-2', '2021-06-15'), entry('fut-1', FUTURE)],
        commits: [...state.json.commits, { key: TT.segmentKey(PAST) }],
      })
    ).status,
  ).toBe(200);
  await stopServer(server.child);
  return { data, md, userId };
}

/** Boot `dir` into `personal` and hand back everything it said. */
async function bootPersonal(data, md) {
  const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
  await until(() => STRANDED_RE.test(server.output()));
  const output = server.output();
  await stopServer(server.child);
  return output;
}

// Red-green for every test below is B1..B5 in the file header — the mutations cut across them.
describe('a boot into `personal` says what it stranded before it says what it retired', () => {
  it('prints the stranding lines, with the numbers this data dir actually holds', async () => {
    const { data, md, userId } = await seededTeamDir('banner-strand');
    const output = await bootPersonal(data, md);

    const stranded = STRANDED_RE.exec(output);
    const range = RANGE_RE.exec(output);
    expect(stranded, `no stranding line in:\n${output}`).toBeTruthy();
    expect(range, `no range line in:\n${output}`).toBeTruthy();

    // The digits, against the dir. Read AFTER the boot, so the cutover it stamped is the one used.
    const want = expectedFromDb(data, userId);
    expect(want.count).toBeGreaterThan(0); // or a no-op implementation passes everything below
    expect(Number(stranded[1])).toBe(want.count);
    expect(range[1]).toBe(want.first);
    expect(range[2]).toBe(want.last);
    const frozen = FROZEN_RE.exec(range[3]);
    expect(frozen, `no freeze clause in ${JSON.stringify(range[3])}`).toBeTruthy();
    expect(Number(frozen[1])).toBe(want.segments);
    expect(want.segments).toBeGreaterThan(0);

    // The stranded set is the pre-cutover one AND the committed one — not everything.
    expect(want.first).toBe(PAST);
    expect(want.last).not.toBe(FUTURE); // the post-cutover day is vault-bound, so it is not stranded
  }, 60000);

  it('says what it stranded BEFORE what it retired — entries first, files last', async () => {
    const { data, md } = await seededTeamDir('banner-order');
    const output = await bootPersonal(data, md);

    const strandedAt = output.search(STRANDED_RE);
    const rangeAt = output.search(RANGE_RE);
    const retiredAt = output.indexOf('[time-turtle] retired mirror ');
    const totalAt = output.search(TOTAL_RE);
    for (const [name, at] of [
      ['stranding', strandedAt],
      ['range', rangeAt],
      ['retired mirror', retiredAt],
      ['retired in total', totalAt],
    ]) {
      expect(at, `${name} line missing from:\n${output}`).toBeGreaterThan(-1);
    }

    // SB-115's rule, as an order over SEPARATE console.log calls — an order asserted inside one
    // call cannot fail, which is why the two stranding lines are two statements.
    expect(strandedAt).toBeLessThan(rangeAt);
    expect(rangeAt).toBeLessThan(retiredAt);
    expect(retiredAt).toBeLessThan(totalAt);
    // …and after the cutover line, because the preflight must read the cutover in force.
    expect(output.search(CUTOVER_RE)).toBeLessThan(strandedAt);

    // The total counts what was really renamed, and this dir had exactly one mirror file.
    expect(Number(TOTAL_RE.exec(output)[1])).toBe(1);
    expect(output.match(/\[time-turtle\] retired mirror /g)).toHaveLength(1);
  }, 60000);

  it('a SECOND boot of the same dir reports the same cutover (first-stamp-wins)', async () => {
    const { data, md, userId } = await seededTeamDir('banner-second');
    const first = await bootPersonal(data, md);
    const stamped = storedSetting(data, 'shapeStamp');

    // Real time between the boots, so a re-stamping implementation moves the instant measurably.
    await new Promise((r) => setTimeout(r, 1100));
    const second = await bootPersonal(data, md);

    expect(CUTOVER_RE.exec(second)[1]).toBe(CUTOVER_RE.exec(first)[1]);
    expect(CUTOVER_RE.exec(second)[1]).toBe(stamped);
    expect(storedSetting(data, 'shapeStamp')).toBe(stamped);
    // Same cutover, same arithmetic, and the mirror file is gone now — so the entries lines repeat
    // and the retirement ones do not. Entries stay stranded; a file is only retired once.
    expect(Number(STRANDED_RE.exec(second)[1])).toBe(expectedFromDb(data, userId).count);
    expect(Number(STRANDED_RE.exec(second)[1])).toBe(Number(STRANDED_RE.exec(first)[1]));
    expect(second).not.toMatch(TOTAL_RE);
  }, 60000);

  it('a personal → team → personal round trip does not count the team interlude', async () => {
    const { data, md, userId } = await seededTeamDir('banner-roundtrip');
    const first = await bootPersonal(data, md);
    const stamped = storedSetting(data, 'shapeStamp');

    // The interlude: boot back into `team` and log a day DURING it, post-cutover.
    const interlude = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(interlude.port);
    const state = await admin('GET', '/api/state');
    expect(
      (
        await admin('PUT', '/api/state', {
          entries: [...state.json.entries, entry('interlude-1', TT.addDays(TT.todayStr(), 3))],
        })
      ).status,
    ).toBe(200);
    await stopServer(interlude.child);

    const back = await bootPersonal(data, md);
    // The cutover did not move, so the interlude's day is post-cutover and is NOT stranded — the
    // count is unchanged even though the timesheet grew by one.
    expect(CUTOVER_RE.exec(back)[1]).toBe(stamped);
    expect(Number(STRANDED_RE.exec(back)[1])).toBe(Number(STRANDED_RE.exec(first)[1]));
    expect(Number(STRANDED_RE.exec(back)[1])).toBe(expectedFromDb(data, userId).count);
  }, 60000);

  it('a `team` boot says nothing about stranding at all', async () => {
    const { data, md } = await seededTeamDir('banner-team');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    await adminOn(server.port);
    // A real sleep, not a poll dressed as one: the lines asserted absent below all print at module
    // top level, i.e. strictly before `/api/me` can answer, so `adminOn` above has already given
    // them every chance to appear. The extra window is belt and braces.
    await new Promise((r) => setTimeout(r, 400));
    const output = server.output();
    await stopServer(server.child);

    expect(output).not.toMatch(STRANDED_RE);
    expect(output).not.toMatch(RANGE_RE);
    expect(output).not.toMatch(TOTAL_RE);
    expect(output).not.toMatch(CUTOVER_RE); // `team` stamps no cutover either (DD-016 scope)
    expect(output).toContain('[time-turtle]'); // …but it did boot and did say things
  }, 60000);

  it('an install with nothing to strand stays quiet, and still retires', async () => {
    // Silence when there is nothing to say is a boot log staying readable, not a missing
    // statement — DD-018's "it always appears" is a rule about the MODAL, which is SB-116's.
    const { data, md } = dataDir('banner-quiet');
    const seed = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team', TT_SEED_DEMO: '0' });
    const admin = await adminOn(seed.port);
    const state = await admin('GET', '/api/state');
    expect(state.json.entries).toEqual([]);
    // A save with no entries still writes the mirror file, so there IS something to retire — and a
    // COMMITTED SEGMENT holding no entries, which is the case that used to print
    //   0 entries … stay in SQLite and never reach the vault
    //   1 commit segment freezes with them
    // where "them" is the empty set: a loss announcement with nothing lost. Nothing was stranded,
    // so there is nothing to say, so nothing is said.
    expect((await admin('PUT', '/api/state', { entries: [], commits: [{ key: TT.segmentKey(PAST) }] })).status).toBe(
      200,
    );
    expect((await admin('GET', '/api/state')).json.commits).toHaveLength(1);
    await stopServer(seed.child);

    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal', TT_SEED_DEMO: '0' });
    await until(() => TOTAL_RE.test(server.output()));
    const output = server.output();
    await stopServer(server.child);

    expect(output).toMatch(CUTOVER_RE); // the cutover still gets stamped and still gets said
    expect(output).not.toMatch(STRANDED_RE); // …but there is nothing stranded to report
    expect(output).not.toMatch(RANGE_RE);
    expect(output).not.toMatch(/commit segment/); // …not even the frozen-segment half
    expect(Number(TOTAL_RE.exec(output)[1])).toBe(1); // and the file was still retired
  }, 60000);

  it('with nothing committed, the range line stands alone — no freeze clause', async () => {
    // The `segments === 0` branch. It shipped in the first cut of this file and nothing asserted
    // it, because every seeded dir here commits a segment: a declared behaviour with no gate is an
    // undeclared one a release later.
    const { data, md } = dataDir('banner-nocommit');
    const seed = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(seed.port);
    const state = await admin('GET', '/api/state');
    expect(state.json.commits).toEqual([]);
    expect((await admin('PUT', '/api/state', { entries: [...state.json.entries, entry('past-1', PAST)] })).status).toBe(
      200,
    );
    await stopServer(seed.child);

    const output = await bootPersonal(data, md);
    const range = RANGE_RE.exec(output);
    expect(range, `no range line in:\n${output}`).toBeTruthy();
    expect(range[3]).toBe(''); // nothing froze, so nothing is claimed to have frozen
    expect(output).not.toMatch(/commit segment/);
    expect(Number(STRANDED_RE.exec(output)[1])).toBeGreaterThan(0);
  }, 60000);

  it('a committed POST-cutover week shows up in the count and pushes `last` past the cutover', async () => {
    // DD-017's ledger-wins-over-date clause, AT THE BANNER. This is why the sentence does not say
    // "entries dated before it": a committed segment freezes WHOLE, so days AFTER the cutover are
    // stranded too and `last` is a date later than the cutover the line above just printed.
    const { data, md, userId } = await seededTeamDir('banner-ledger');
    const resume = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(resume.port);
    const span = [1, 2, 3].map((n) => TT.addDays(TT.todayStr(), n));
    const state = await admin('GET', '/api/state');
    const known = new Set(state.json.commits.map((c) => c.key));
    const keys = [...new Set(span.map((d) => TT.segmentKey(d)))].filter((k) => !known.has(k));
    expect(keys.length).toBeGreaterThan(0);
    expect(
      (
        await admin('PUT', '/api/state', {
          entries: [...state.json.entries, ...span.map((d, i) => entry('span-' + i, d))],
          commits: [...state.json.commits, ...keys.map((key) => ({ key }))],
        })
      ).status,
    ).toBe(200);
    await stopServer(resume.child);

    const output = await bootPersonal(data, md);
    const want = expectedFromDb(data, userId);
    const cutoverDay = CUTOVER_RE.exec(output)[1].slice(0, 10);
    expect(Number(STRANDED_RE.exec(output)[1])).toBe(want.count);
    // THE CLAIM: the last stranded day is AFTER the cutover, which a date-only rule cannot produce.
    expect(RANGE_RE.exec(output)[2]).toBe(want.last);
    expect(want.last > cutoverDay).toBe(true);
    expect(want.last).toBe(span[span.length - 1]);
  }, 60000);
});
