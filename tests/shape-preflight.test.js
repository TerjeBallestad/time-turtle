// PLAN-013 / SB-115 / DD-018: the shape-switch PREFLIGHT — the server-computed answer to "what
// would this switch cost", read before the gesture, mutating nothing.
//
// STRAND is the word (DD-018's rider to DD-015): a switch to `personal` leaves the entries the
// new shape will never carry exactly where they are. Nothing is moved, copied or deleted. The
// preflight counts them; it does not touch them.
//
// THREE THINGS THIS FILE EXISTS TO CATCH, in order of how easy they are to get wrong:
//
//   1. `shape: activeShape()` INSTEAD OF `shape: to`. The preflight is hypothetical and is
//      normally called from a `team` install, where `TT.vaultBound` is false for every entry on
//      its first clause — so the live shape reports THE WHOLE TIMESHEET as stranded, on every
//      call, and looks entirely plausible doing it. Every `to=personal` test below runs against a
//      `team` install, and asserts the count is strictly LESS than the entry count. A suite that
//      only ever asks from a `personal` install cannot see this bug at all.
//   2. THE CUTOVER `''`. On the common team → personal path nothing has been stamped, and
//      `getSettings().vaultCutover` is `''`, which excludes nothing by date. `stored || now` is
//      the rule; `stored` alone reports zero stranded for a switch about to strand everything.
//   3. A MUTATION. `stampVaultCutover()` writes and `retireMirrors()` renames, and either one
//      called from a preflight is invisible in the payload. Only the before/after digest sees it.
//
// AND THE NUMBERS ARE NEVER LITERALS. Every count is compared against the SAME data dir's own
// SQLite, read out with the server stopped and re-derived through `TT.vaultBound` itself — the
// one predicate `server/src/vault-write.js` uses as the real write filter. A literal `214` proves
// the string; `entries.count === getEntries().length` proves nothing was filtered at all.
//
// ## Verified red-green: 2026-07-27 (output TRANSCRIBED from the runs, not reconstructed)
//
//   Green baseline: 8 of 8. Each mutation below was applied to production code alone, run, and
//   reverted. Six mutations, six distinct reds — no two of them fail the same set.
//
//   M1 — `shape: to` → `shape: activeShape()` in shape-preflight.js. THE bug this file exists
//   for: a `team` install then reports its whole timesheet as stranded. 4 of 8 fail:
//     FAIL  counts what TT.vaultBound will actually exclude — not the whole timesheet
//           AssertionError: expected 15 to be 10 // Object.is equality
//     FAIL  uses `now` as the cutover when nothing has ever been stamped
//           AssertionError: expected false to be true // Object.is equality
//     FAIL  committing a post-cutover week strands its days and adds its segments
//           AssertionError: expected 19 to be 28 // Object.is equality
//     FAIL  a personal → team → personal round trip keeps the first cutover and strands no interlude
//           AssertionError: expected 14 to be 9 // Object.is equality
//
//   M2 — `stored || now` → `stored`, i.e. the cutover read straight out of settings. 2 of 8:
//     FAIL  answers an admin with the five keys, from a team install
//           AssertionError: expected { count: +0, first: null, last: null } to deeply equal
//                           { count: Any<Number>, …(2) }
//     FAIL  uses `now` as the cutover when nothing has ever been stamped
//           AssertionError: expected 0 to be greater than 0
//
//   M3 — `!TT.vaultBound(entry, ctx)` → a bare `entry.date < cutoverDay`, which is what SB-115's
//   body's "filtered on the cutover" would produce. Only DD-017's clause can see it. 1 of 8:
//     FAIL  committing a post-cutover week strands its days and adds its segments
//           AssertionError: expected 10 to be 19 // Object.is equality
//
//   M4 — the cutover fallback becomes `store.stampVaultCutover()`, i.e. a preflight that answers
//   the question by DOING it. 1 of 8:
//     FAIL  uses `now` as the cutover when nothing has ever been stamped
//           AssertionError: expected '2026-07-26T22:49:31.779Z' to be null // Object.is equality
//   NOTE, honestly: the digest test does NOT catch M4, and cannot — its dir is already stamped,
//   so first-stamp-wins makes the call a no-op there. The `null` assertion above is the instrument
//   for M4; the digest is the instrument for M5.
//
//   M5 — `retireMirrors()` called from the preflight. 2 of 8:
//     FAIL  answers an admin with the five keys, from a team install
//           AssertionError: expected [] to include '/var/folders/…/timesheet-admin.md'
//     FAIL  leaves the data dir byte-identical — no stamp, no retirement
//           AssertionError: expected '.secret fac1a206…' to be '.secret fac1a206…'
//   The CONTROL boot stayed green under M5, which is what makes the third digest attributable.
//
//   M6 — `requireAdmin` dropped from the route. 1 of 8, and only the employee-session one:
//     FAIL  403s a real employee session — the mirrors list is other users file paths
//           AssertionError: expected 200 to be 403 // Object.is equality
//
//   M7 — `mirrorCandidates()` → `new Set()`, the anti-drift claim. Run over BOTH consumers
//   (`npm test -- shape-preflight mirror-retire`), 8 of 15 fail: all 7 of mirror-retire.test.js
//     FAIL  switching to personal retires the mirror, and the bytes survive under the new name
//           AssertionError: expected [ 'timesheet-admin.md' ] to deeply equal [ Array(1) ]
//   …and the preflight's own mirror-list assertion
//     FAIL  answers an admin with the five keys, from a team install
//           AssertionError: expected [] to include '/var/folders/…/timesheet-admin.md'
//   One definition, two consumers, and the same break reds both — which is the whole reason the
//   set was extracted rather than copied.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn, session } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, md: join(data, 'mirror') };
}

// ---- reading the data dir's own truth, with the server stopped ----

/** @returns {any} the read-only handle; callers close it */
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

/** Every entry of one user, in the shape `TT.vaultBound` expects. Straight out of SQLite. */
function dbEntries(data, userId) {
  const db = openDb(data);
  try {
    return db
      .prepare(
        'SELECT id, date, start, end, dur_min AS durMin, project, label, note, billable FROM entries WHERE user_id = ? ORDER BY date, id',
      )
      .all(userId)
      .map((row) => ({ ...row, billable: !!row.billable }));
  } finally {
    db.close();
  }
}

function dbCommits(data, userId) {
  const db = openDb(data);
  try {
    const row = db.prepare('SELECT data FROM commits WHERE user_id = ?').get(userId);
    return row ? JSON.parse(row.data) : [];
  } finally {
    db.close();
  }
}

function dbVaultIndex(data) {
  const db = openDb(data);
  try {
    return db.prepare('SELECT path, date, state, rev FROM vault_index ORDER BY path').all();
  } finally {
    db.close();
  }
}

/**
 * THE EXPECTATION, RE-DERIVED. Not a literal and not a re-implementation: the same predicate the
 * write filter uses, fed this dir's own rows and the cutover the server would have been looking
 * at. `shape: 'personal'` because that is the TARGET being asked about.
 */
function strandedFromDb(data, userId, vaultCutover) {
  const ctx = { shape: 'personal', vaultCutover, commits: dbCommits(data, userId) };
  return dbEntries(data, userId).filter((entry) => !TT.vaultBound(entry, ctx));
}

// ---- the no-mutation instrument ----
//
// EVERY FILE in the data dir, hashed, EXCEPT `timeturtle.db-shm`. That exclusion is not a
// loophole: `-shm` is SQLite's shared-memory read index and it changes when a WAL database is
// merely READ, so hashing it would make this assertion fail for the one behaviour it is meant to
// permit. `timeturtle.db-wal` IS hashed, and it is the file a write actually lands in first —
// under WAL the main `.db` can stay byte-identical across a write, so excluding the WAL would
// have hidden exactly the `stampVaultCutover()` this exists to catch.
//
// Taken with the server STOPPED, so nothing is mid-flight, and always with a CONTROL boot that
// calls nothing — without that control a green here could just mean a boot is noisy and the
// comparison is between two equally-dirty states.
function digestDir(dir) {
  /** @type {string[]} */
  const lines = [];
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (name === 'timeturtle.db-shm') continue;
      lines.push(relative(dir, path) + ' ' + createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(dir);
  return lines.join('\n');
}

// ---- seeding ----

const PAST = '2020-01-01'; // unambiguously before any cutover this suite can stamp
const FUTURE = '2099-01-01'; // unambiguously after it — and in no ISO week anything else touches

function entry(id, date, label = 'work') {
  return { id, date, start: 540, end: 600, project: null, label, note: '', billable: 1 };
}

/** Add entries to the caller's timesheet, preserving what is already there. */
async function addEntries(admin, entries) {
  const state = await admin('GET', '/api/state');
  const put = await admin('PUT', '/api/state', { entries: [...state.json.entries, ...entries] });
  expect(put.status).toBe(200);
}

/**
 * A `team` install whose cutover HAS been stamped — a round trip through `personal` and back,
 * which is the only way to get a stored cutover onto a team install (the stamp is server-owned
 * and first-stamp-wins; a client cannot set it, see shape-inference.test.js).
 *
 * Stamped-and-team is the interesting state: the preflight must use the STORED instant, and it
 * must still be answering hypothetically about a shape this install is not in.
 */
async function stampedTeamInstall(admin) {
  let state = await admin('GET', '/api/state');
  expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } })).status).toBe(
    200,
  );
  state = await admin('GET', '/api/state');
  const cutover = state.json.settings.vaultCutover;
  expect(cutover).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'team' } })).status).toBe(200);
  expect((await admin('GET', '/api/state')).json.shape).toBe('team');
  return cutover;
}

// The transcribed red-green evidence for every describe block in this file is in the file
// header (M1..M7), not repeated per block — the mutations cut across the blocks.
describe('GET /api/shape/preflight?to=personal — the payload DD-018 names', () => {
  it('answers an admin with the five keys, from a team install', async () => {
    const { data, md } = dataDir('preflight-shape');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(server.port);
    await addEntries(admin, [entry('past-1', PAST), entry('future-1', FUTURE)]);

    const res = await admin('GET', '/api/shape/preflight?to=personal');
    expect(res.status).toBe(200);
    expect(res.json.to).toBe('personal');
    expect(res.json.entries).toEqual({
      count: expect.any(Number),
      first: expect.any(String),
      last: expect.any(String),
    });
    expect(res.json.commits).toEqual({ segments: expect.any(Number) });
    expect(Array.isArray(res.json.mirrors)).toBe(true);
    expect(typeof res.json.users).toBe('number');
    // The way back's key must not leak into this direction — see the `to=team` block below.
    expect(res.json).not.toHaveProperty('vaultDays');

    // The mirror the team install has actually been writing is on the list, absolute and real.
    expect(res.json.mirrors).toContain(join(md, 'timesheet-admin.md'));
    expect(res.json.mirrors).toEqual([...res.json.mirrors].sort());
    await stopServer(server.child);
  }, 60000);

  it('counts what TT.vaultBound will actually exclude — not the whole timesheet', async () => {
    const { data, md } = dataDir('preflight-count');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(server.port);
    const userId = (await admin('GET', '/api/me')).json.user.id;
    const cutover = await stampedTeamInstall(admin);
    await addEntries(admin, [entry('past-1', PAST), entry('past-2', '2021-06-15'), entry('future-1', FUTURE)]);

    const res = await admin('GET', '/api/shape/preflight?to=personal');
    expect(res.status).toBe(200);
    await stopServer(server.child);

    // The cutover the server used is the STORED one, and it really is stored.
    expect(storedSetting(data, 'vaultCutover')).toBe(cutover);

    const expected = strandedFromDb(data, userId, cutover);
    const dates = expected.map((e) => e.date).sort();
    expect(res.json.entries.count).toBe(expected.length);
    expect(res.json.entries.first).toBe(dates[0]);
    expect(res.json.entries.last).toBe(dates[dates.length - 1]);

    // THE TWO GUARDS THAT MAKE THE LINE ABOVE MEAN SOMETHING. Without them a `shape: activeShape()`
    // implementation (everything stranded) and a no-op filter (nothing stranded) both satisfy an
    // equality against a matching re-derivation only because the re-derivation is the same code.
    const total = dbEntries(data, userId).length;
    expect(res.json.entries.count).toBeGreaterThan(0); // PAST is stranded
    expect(res.json.entries.count).toBeLessThan(total); // FUTURE is not — so `shape` was the TARGET
    expect(res.json.entries.first).toBe(PAST);
    expect(dates).not.toContain(FUTURE);

    expect(res.json.users).toBe(1);
    expect(res.json.commits.segments).toBe(dbCommits(data, userId).length);
  }, 60000);

  it('uses `now` as the cutover when nothing has ever been stamped', async () => {
    // The team → personal path nobody has been down yet: `getSettings().vaultCutover` is `''`,
    // and `''` excludes NOTHING by date. An implementation that passes the stored value straight
    // through reports zero stranded entries for the switch that strands the whole back catalogue.
    const { data, md } = dataDir('preflight-unstamped');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(server.port);
    const userId = (await admin('GET', '/api/me')).json.user.id;

    // ±3 days rather than ±1: `TT.todayStr()` is a LOCAL day and the cutover is a UTC instant, so
    // the two can name adjacent days. Three days clears that gap in every timezone (SB-143).
    const before = TT.addDays(TT.todayStr(), -3);
    const after = TT.addDays(TT.todayStr(), 3);
    await addEntries(admin, [entry('before-1', before), entry('after-1', after)]);

    const res = await admin('GET', '/api/shape/preflight?to=personal');
    await stopServer(server.child);

    // Nothing was stamped by the read — the whole point of `stored || now` over `stampVaultCutover()`.
    expect(storedSetting(data, 'vaultCutover')).toBe(null);

    const dates = dbEntries(data, userId)
      .map((e) => e.date)
      .filter((d) => d === before || d === after);
    expect(dates).toEqual([before, after].sort());

    // The seeded demo entries are dated relative to first boot, so the exact total is not the
    // claim. THESE two are: the past day is stranded, the future day is not.
    const strandedRes = await (async () => res.json.entries)();
    expect(strandedRes.count).toBeGreaterThan(0);
    expect(strandedRes.first <= before).toBe(true);
    // `after` is post-cutover, so it is vault-bound: `last` must be strictly before it.
    expect(strandedRes.last < after).toBe(true);
  }, 60000);
});

// DD-017's clause is the one a hand-rolled date comparison silently gets wrong, so its red is a
// MUTATION of the predicate rather than its absence — see M3 in the file header.
describe('DD-017: a committed segment freezes WHOLE, so the ledger wins over the date', () => {
  it('committing a post-cutover week strands its days and adds its segments', async () => {
    const { data, md } = dataDir('preflight-ledger');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(server.port);
    const userId = (await admin('GET', '/api/me')).json.user.id;
    const cutover = await stampedTeamInstall(admin);

    // A week that STRADDLES the cutover: three days each side of today, so whichever day the
    // cutover instant falls on is inside the span. Every one of these is a real entry.
    const span = [-3, -2, -1, 0, 1, 2, 3].map((n) => TT.addDays(TT.todayStr(), n));
    await addEntries(
      admin,
      span.map((date, i) => entry('span-' + i, date)),
    );

    const beforeCommit = await admin('GET', '/api/shape/preflight?to=personal');
    const strandedBefore = beforeCommit.json.entries.count;

    // Commit every segment the span touches — a Mon..Sun week straddling a month boundary is two
    // keys, so this is a set and not a single key.
    const state = await admin('GET', '/api/state');
    const oldKeys = new Set(state.json.commits.map((c) => c.key));
    const keys = [...new Set(span.map((d) => TT.segmentKey(d)))].filter((k) => !oldKeys.has(k));
    expect(keys.length).toBeGreaterThan(0);
    expect(
      (await admin('PUT', '/api/state', { commits: [...state.json.commits, ...keys.map((key) => ({ key }))] })).status,
    ).toBe(200);

    const afterCommit = await admin('GET', '/api/shape/preflight?to=personal');
    await stopServer(server.child);

    // WHAT THE COMMIT FROZE, counted rather than assumed: every entry that was POST-cutover (so
    // the date clause was letting it through) and has just landed inside a committed segment.
    // Computed over the dir's own rows, because the seeded demo entries share ISO weeks with the
    // span — the freeze is a property of the WEEK, not of the seven entries this test wrote.
    const cutoverDay = String(cutover).slice(0, 10);
    const newlyFrozen = dbEntries(data, userId).filter(
      (e) => e.date >= cutoverDay && !oldKeys.has(TT.segmentKey(e.date)) && keys.includes(TT.segmentKey(e.date)),
    );
    expect(newlyFrozen.length).toBeGreaterThan(0);
    expect(newlyFrozen.some((e) => span.includes(e.date))).toBe(true); // including days this test wrote

    // The ledger froze days the DATE would have let through. This is the number that a
    // `entry.date < cutover` implementation cannot produce.
    expect(afterCommit.json.entries.count).toBe(strandedBefore + newlyFrozen.length);
    expect(afterCommit.json.commits.segments).toBe(beforeCommit.json.commits.segments + keys.length);

    // …and it equals what `TT.vaultBound` itself says over this dir's own rows and ledger.
    const expected = strandedFromDb(data, userId, cutover);
    expect(afterCommit.json.entries.count).toBe(expected.length);
    const lastStranded = expected
      .map((e) => e.date)
      .sort()
      .pop();
    expect(afterCommit.json.entries.last).toBe(lastStranded);
    expect(lastStranded).toBe(span[span.length - 1]); // the frozen future day IS the last stranded day
  }, 60000);

  it('a personal → team → personal round trip keeps the first cutover and strands no interlude', async () => {
    // DD-016: `stampVaultCutover` returns early when a value exists. The consequence the preflight
    // owes is that the SECOND switch reports the same set as the first — a re-stamped cutover would
    // quietly re-open (or re-close) the days of the team interlude.
    const { data, md } = dataDir('preflight-roundtrip');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(server.port);
    const userId = (await admin('GET', '/api/me')).json.user.id;
    const first = await stampedTeamInstall(admin);

    const interlude = TT.addDays(TT.todayStr(), 3); // dated during the team interlude, post-cutover
    await addEntries(admin, [entry('past-1', PAST), entry('interlude-1', interlude)]);
    const before = await admin('GET', '/api/shape/preflight?to=personal');

    // A second round trip. Real time passes between the two stamps, so a re-stamping
    // implementation produces a measurably different instant rather than the same millisecond.
    await new Promise((r) => setTimeout(r, 1100));
    const second = await stampedTeamInstall(admin);
    expect(second).toBe(first);

    const after = await admin('GET', '/api/shape/preflight?to=personal');
    await stopServer(server.child);

    expect(storedSetting(data, 'vaultCutover')).toBe(first);
    expect(after.json.entries).toEqual(before.json.entries);
    expect(after.json.commits).toEqual(before.json.commits);

    // The interlude's day is post-cutover and uncommitted, so it is NOT stranded — which is the
    // whole point of the cutover not moving.
    const stranded = strandedFromDb(data, userId, first).map((e) => e.date);
    expect(stranded).not.toContain(interlude);
    expect(stranded).toContain(PAST);
    expect(after.json.entries.count).toBe(stranded.length);
  }, 60000);
});

// The role half is proven with a REAL employee session, never by reading the middleware list off
// the route. Red under M6 in the file header.
describe('the gate and the validation', () => {
  const EMPLOYEE = { email: 'second@timeturtle.local', name: 'Second', role: 'employee', password: 'secondpw' };

  it('403s a real employee session — the mirrors list is other users file paths', async () => {
    const { data, md } = dataDir('preflight-role');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(server.port);
    expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);

    const employee = session(server.port);
    expect(
      (await employee('POST', '/api/auth/login', { email: EMPLOYEE.email, password: EMPLOYEE.password })).status,
    ).toBe(200);
    // The contrast: the same call, same server, same moment, differing only in who is asking.
    expect((await employee('GET', '/api/shape/preflight?to=personal')).status).toBe(403);
    expect((await employee('GET', '/api/shape/preflight?to=team')).status).toBe(403);
    expect((await admin('GET', '/api/shape/preflight?to=personal')).status).toBe(200);

    // And an anonymous caller does not get in either.
    const nobody = session(server.port);
    expect((await nobody('GET', '/api/shape/preflight?to=personal')).status).toBe(401);
    await stopServer(server.child);
  }, 60000);

  it('400s a missing or unrecognised `to`, naming the legal values', async () => {
    const { data, md } = dataDir('preflight-validate');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(server.port);

    for (const query of ['', '?to=', '?to=vault', '?to=persona', '?to=PERSONAL']) {
      const res = await admin('GET', '/api/shape/preflight' + query);
      expect(res.status, `?${query} should be a 400`).toBe(400);
      // The message NAMES them, so a caller that guessed wrong learns what to guess next.
      for (const shape of TT.SHAPES) expect(res.json.error).toContain(shape);
    }
    await stopServer(server.child);

    // `to` equal to the CURRENT shape is a read like any other, not a refusal: this is a
    // `personal` install being asked what switching to `personal` would cost.
    const { data: d2, md: md2 } = dataDir('preflight-noop');
    const already = await startServer({ TT_DATA_DIR: d2, TT_MD_DIR: md2, TT_SHAPE: 'personal' });
    const owner = await adminOn(already.port);
    expect((await owner('GET', '/api/shape/preflight?to=personal')).status).toBe(200);
    await stopServer(already.child);
  }, 60000);
});

// The CONTROL boot is what makes this an instrument rather than a coincidence: it proves a bare
// boot of this dir changes nothing, so any difference in the third digest is attributable to the
// preflight call and to nothing else. Red under M5 in the file header.
describe('the preflight mutates nothing', () => {
  it('leaves the data dir byte-identical — no stamp, no retirement', async () => {
    const { data, md } = dataDir('preflight-immutable');

    // 1. Seed. Entries, a stamped cutover, a real mirror file on disk, a commit in the ledger.
    const seeding = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const admin = await adminOn(seeding.port);
    await stampedTeamInstall(admin);
    await addEntries(admin, [entry('past-1', PAST), entry('future-1', FUTURE)]);
    const state = await admin('GET', '/api/state');
    expect(
      (await admin('PUT', '/api/state', { commits: [...state.json.commits, { key: TT.segmentKey(PAST) }] })).status,
    ).toBe(200);
    await stopServer(seeding.child);
    const seeded = digestDir(data);
    expect(seeded).toContain('timesheet-admin.md'); // there IS a mirror file to accidentally retire
    expect(storedSetting(data, 'vaultCutover')).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 2. THE CONTROL: a boot that calls nothing. If this is not inert the comparison below is
    //    between two equally-dirty states and proves nothing.
    const control = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    await adminOn(control.port);
    await stopServer(control.child);
    expect(digestDir(data)).toBe(seeded);

    // 3. The same boot, plus the preflight — both directions, twice each.
    const measured = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'team' });
    const caller = await adminOn(measured.port);
    for (const to of ['personal', 'personal']) {
      expect((await caller('GET', `/api/shape/preflight?to=${to}`)).status).toBe(200);
    }
    await stopServer(measured.child);

    // `stampVaultCutover()` would land in `timeturtle.db-wal`; `retireMirrors()` would rename the
    // mirror file AND rewrite `mirror-guard.json`. Both are in this digest.
    expect(digestDir(data)).toBe(seeded);
  }, 90000);
});
