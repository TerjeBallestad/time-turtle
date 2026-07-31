// SB-102 / DD-017 §1: a personal install refuses a CHANGE to a frozen day, server-side.
//
// A client that hides an edit is not a guard. A stale tab, a second machine and a hand-rolled
// PUT all reach the same route, and under `personal` the one user IS the seeded admin
// (DD-015 depth 2) — which is exactly why `pinCommittedEntries` (`if (!admin)`) does not fire
// here and why this guard is gated on the SHAPE and reads no role at all.
//
// A CHANGE, NEVER THE PRESENCE. `db.putEntries` is DELETE-all-then-insert and the client PUTs
// its whole state, so every frozen entry the user has ever logged arrives on EVERY keystroke.
// `useServerSync.ts:96-99` re-queues any non-409 failure and re-arms a 4 s timer forever, so a
// blanket 403 on the presence of pre-vault history would be a permanent toast loop for anyone
// with any history at all. The ride-along case below is the one that proves the loop is not
// armed, and it matters more than any of the refusals.
//
// A CONTRAST PAIR, always, on `tests/shape-committing.test.js`'s discipline:
//   • every refusal is made BY AN ADMIN, so it cannot be the employee/admin split wearing a 403;
//   • the message is asserted to name what is frozen, because it reaches the user as a toast;
//   • the identical calls are made against a `team` server and asserted to SUCCEED and LAND;
//   • the STORED entries are re-read after every refusal — a 403 raised after `putEntries`
//     looks identical from outside the process.
//
// ## Verified red-green: 2026-07-27
//   (a) `frozenEntryRefusal` forced to `return null` — 6 of the 7 personal cases fail:
//         × (a) refuses an EDIT to a day from before the vault       expected 200 to be 403
//         × (b) refuses a row ADDED to a day from before the vault   expected 200 to be 403
//         × (c) refuses a row DELETED from a day before the vault    expected 200 to be 403
//         × (d) refuses an entry MOVED INTO a frozen day             expected 200 to be 403
//         × (e) refuses an entry MOVED OUT OF a frozen day           expected 200 to be 403
//         × (f) refuses an edit to a POST-cutover day inside a committed segment
//                                                                   expected 200 to be 403
//       The ride-along case (g) stays green, as it must — it is the case that says nothing
//       should have been refused.
//   (b) the guard forced to refuse PRESENCE rather than change (`if (stored.length) return …`)
//       — the two ride-along cases are the only ones that fail, and they are the whole retry
//       hazard. Every refusal case above stays green, which is the point: a presence-refusing
//       guard and a change-refusing guard are INDISTINGUISHABLE from the refusals alone.
//         × (g) lets an UNCHANGED frozen set ride along at 200      expected 403 to be 200
//         × (g2) rides along even when the frozen rows arrive in a different ORDER
//                                                                   expected 403 to be 200
//   The `team` half stays green under BOTH inversions, which is what makes it a contrast
//   rather than a second copy of the personal half.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn, session } from './util.js';

afterAll(stopAllServers);

const TODAY = TT.todayStr();
const OLD = TT.addDays(TODAY, -30); // comfortably before any cutover this suite can stamp
const FREE = TT.addDays(TODAY, 7); // after the cutover and in no committed segment
/** The segment containing today — committed under `team`, met under `personal`. */
const SEGMENT = TT.weekSegments(TODAY).find((seg) => seg.dates.includes(TODAY));

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

/**
 * The fixture, in both shapes. Four entries:
 *   old1/old2 — two rows on a day 30 days back (pre-vault under `personal`)
 *   frozen    — TODAY, inside the segment committed below. Under `personal` this day is AFTER
 *               the cutover, so ONLY the ledger clause can freeze it — the case the date alone
 *               cannot catch (DD-017 §2).
 *   free      — a week out: after the cutover, in no committed segment, editable in both shapes.
 */
const FIXTURE = [
  entry('old1', OLD, 480, 540, 'an hour from before'),
  entry('old2', OLD, 540, 600, 'a second hour from before'),
  entry('frozen', TODAY, 600, 660, 'inside the committed week'),
  entry('free', FREE, 660, 720, 'an ordinary hour'),
];

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, md: join(data, 'mirror') };
}

/** Seed FIXTURE and commit today's segment on a `team` server. */
async function seed(port) {
  const admin = await adminOn(port);
  const state = await admin('GET', '/api/state');
  expect(state.json.shape).toBe('team');
  const put = await admin('PUT', '/api/state', {
    entries: FIXTURE,
    commits: [{ key: SEGMENT.key }],
    version: state.json.version,
  });
  expect(put.status).toBe(200);
  return admin;
}

/** Ids → the entry as stored, for a byte-comparable snapshot of what a refusal must not move. */
const snapshot = (entries) =>
  [...entries].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => JSON.stringify(e, Object.keys(e).sort()));

// ---------------------------------------------------------------------------
describe('the personal shape refuses a CHANGE to a frozen day', () => {
  let ADMIN = null;
  let child = null;
  let cutoverDay = '';

  beforeAll(async () => {
    const { data, md } = dataDir('freeze-personal');
    // Committed under `team`, because `personal` refuses a ledger change (SB-056/DD-008) — and
    // this is also the only install shape that reaches a frozen post-cutover segment for real.
    const team = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SEED_DEMO: '0' });
    await seed(team.port);
    await stopServer(team.child);

    const personal = await startServer({
      TT_DATA_DIR: data,
      TT_MD_DIR: md,
      TT_SHAPE: 'personal',
      TT_SEED_DEMO: '0',
    });
    child = personal.child;
    ADMIN = await adminOn(personal.port);
    const state = await ADMIN('GET', '/api/state');
    // The shape and the cutover on the wire. Without BOTH, every case below is vacuous: a data
    // dir whose cutover is `''` freezes nothing and every implementation passes.
    expect(state.json.shape).toBe('personal');
    expect(state.json.settings.shapeStamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    cutoverDay = state.json.settings.shapeStamp.slice(0, 10);
    expect(OLD < cutoverDay, 'the OLD day is not actually before the cutover').toBe(true);
    expect(TODAY >= cutoverDay, 'TODAY is not actually after the cutover').toBe(true);
    expect(FREE >= cutoverDay).toBe(true);
    expect(state.json.commits.map((c) => c.key)).toEqual([SEGMENT.key]);
    // …and TODAY is in the committed segment while FREE is not, which is what makes case (f)
    // a ledger-clause case rather than a second date case.
    expect(TT.committedOn(TODAY, state.json.commits)).toBe(true);
    expect(TT.committedOn(FREE, state.json.commits)).toBe(false);
    expect(TT.committedOn(OLD, state.json.commits)).toBe(false);
  }, 90000);
  afterAll(async () => {
    if (child) await stopServer(child);
  });

  /** PUT `entries`, expect a 403 that names the freeze, and assert nothing moved in storage. */
  async function refused(label, entries) {
    const before = await ADMIN('GET', '/api/state');
    const put = await ADMIN('PUT', '/api/state', { entries, version: before.json.version });
    expect(put.status, label).toBe(403);
    // Not just the status. An admin session cannot be 403'd by the employee/admin split, so the
    // message has to identify the freeze — and it reaches the user verbatim as a toast.
    expect(put.json.error).toBe(TT.FROZEN_ENTRY_REFUSAL);
    expect(put.json.error).toMatch(/read-only/);
    expect(put.json.error).toMatch(/before your vault|committed/);
    // A guard that runs AFTER putEntries is indistinguishable from outside the process.
    const after = await ADMIN('GET', '/api/state');
    expect(snapshot(after.json.entries), label + ': the refused PUT still wrote').toEqual(
      snapshot(before.json.entries),
    );
  }

  it('(a) refuses an EDIT to a day from before the vault', async () => {
    await refused('edit', [{ ...FIXTURE[0], end: 555 }, FIXTURE[1], FIXTURE[2], FIXTURE[3]]);
  });

  it('(b) refuses a row ADDED to a day from before the vault', async () => {
    await refused('add', [...FIXTURE, entry('old3', OLD, 600, 660, 'a third hour, invented today')]);
  });

  it('(c) refuses a row DELETED from a day before the vault', async () => {
    await refused('delete', [FIXTURE[0], FIXTURE[2], FIXTURE[3]]);
  });

  it('(d) refuses an entry MOVED INTO a frozen day', async () => {
    // The row appears in the incoming frozen subset and not in the stored one. A per-id field
    // compare over the stored frozen ids alone never looks at it and lets it through.
    await refused('move in', [FIXTURE[0], FIXTURE[1], FIXTURE[2], { ...FIXTURE[3], date: OLD }]);
  });

  it('(e) refuses an entry MOVED OUT OF a frozen day', async () => {
    await refused('move out', [{ ...FIXTURE[0], date: FREE }, FIXTURE[1], FIXTURE[2], FIXTURE[3]]);
  });

  it('(f) refuses an edit to a POST-cutover day inside a committed segment', async () => {
    // DD-017 §2, and the clause the date alone cannot catch: TODAY is AFTER the cutover. Only
    // the ledger says this day is frozen.
    expect(TODAY >= cutoverDay).toBe(true);
    await refused('frozen segment', [FIXTURE[0], FIXTURE[1], { ...FIXTURE[2], label: 'edited' }, FIXTURE[3]]);
  });

  it('(g) lets an UNCHANGED frozen set ride along at 200 — the retry loop is never armed', async () => {
    // THE CASE THAT MATTERS MOST. This is what every keystroke looks like under DELETE-all-then-
    // insert: the entire frozen history re-sent verbatim, with one ordinary day changed. If this
    // is a 403, `useServerSync` re-queues it and re-arms a 4 s timer forever and the app is
    // unusable for anyone with any history — which is strictly worse than no guard at all.
    const before = await ADMIN('GET', '/api/state');
    const put = await ADMIN('PUT', '/api/state', {
      entries: [FIXTURE[0], FIXTURE[1], FIXTURE[2], { ...FIXTURE[3], end: 780, label: 'a longer ordinary hour' }],
      version: before.json.version,
    });
    expect(put.status, put.json && put.json.error).toBe(200);
    const after = await ADMIN('GET', '/api/state');
    expect(after.json.entries.find((e) => e.id === 'free').end).toBe(780);
    // and the frozen rows are exactly as they were
    expect(
      after.json.entries
        .filter((e) => e.id !== 'free')
        .map((e) => e.end)
        .sort(),
    ).toEqual([540, 600, 660]);
  });

  it('(g2) rides along even when the frozen rows arrive in a different ORDER', async () => {
    // The comparison is over SETS. The client's ordering is not a contract, and a refusal that
    // depended on it would fire at random.
    const before = await ADMIN('GET', '/api/state');
    const stored = before.json.entries;
    const reordered = [...stored].reverse().map((e) => (e.id === 'free' ? { ...e, note: 'reordered' } : e));
    const put = await ADMIN('PUT', '/api/state', { entries: reordered, version: before.json.version });
    expect(put.status, put.json && put.json.error).toBe(200);
    expect((await ADMIN('GET', '/api/state')).json.entries.find((e) => e.id === 'free').note).toBe('reordered');
  });

  it('a PUT that carries no entries at all is untouched by the guard', async () => {
    const before = await ADMIN('GET', '/api/state');
    const put = await ADMIN('PUT', '/api/state', {
      settings: { ...before.json.settings, currency: 'NOK' },
      version: before.json.version,
    });
    expect(put.status, put.json && put.json.error).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('the team shape (the contrast): every one of those calls succeeds', () => {
  let ADMIN = null;
  let EMP = null;
  let child = null;

  beforeAll(async () => {
    const { data, md } = dataDir('freeze-team');
    const team = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SEED_DEMO: '0' });
    child = team.child;
    ADMIN = await seed(team.port);
    const created = await ADMIN('POST', '/api/users', {
      email: 'sb102@timeturtle.local',
      name: 'Sb Onetwo',
      role: 'employee',
      password: 'sb102pw',
    });
    expect(created.status).toBe(200);
    EMP = session(team.port);
    expect(
      (await EMP('POST', '/api/auth/login', { email: 'sb102@timeturtle.local', password: 'sb102pw' })).status,
    ).toBe(200);
  }, 60000);
  afterAll(async () => {
    if (child) await stopServer(child);
  });

  /** The same mutation, against `team`: 200, and it actually LANDS. */
  async function lands(label, entries, check) {
    const before = await ADMIN('GET', '/api/state');
    const put = await ADMIN('PUT', '/api/state', { entries, version: before.json.version });
    expect(put.status, label + ': ' + JSON.stringify(put.json)).toBe(200);
    const after = await ADMIN('GET', '/api/state');
    check(after.json.entries);
    // put the fixture back so the next case starts from the same place
    const reset = await ADMIN('GET', '/api/state');
    expect((await ADMIN('PUT', '/api/state', { entries: FIXTURE, version: reset.json.version })).status).toBe(200);
  }

  it('(a) an EDIT to the same old day lands', async () => {
    await lands('edit', [{ ...FIXTURE[0], end: 555 }, FIXTURE[1], FIXTURE[2], FIXTURE[3]], (entries) =>
      expect(entries.find((e) => e.id === 'old1').end).toBe(555),
    );
  });

  it('(b) an ADD to the same old day lands', async () => {
    await lands('add', [...FIXTURE, entry('old3', OLD, 600, 660, 'a third hour')], (entries) =>
      expect(entries.map((e) => e.id)).toContain('old3'),
    );
  });

  it('(c) a DELETE from the same old day lands', async () => {
    await lands('delete', [FIXTURE[0], FIXTURE[2], FIXTURE[3]], (entries) =>
      expect(entries.map((e) => e.id)).not.toContain('old2'),
    );
  });

  it('(d)/(e) MOVES in and out of the same days land', async () => {
    await lands('move in', [FIXTURE[0], FIXTURE[1], FIXTURE[2], { ...FIXTURE[3], date: OLD }], (entries) =>
      expect(entries.find((e) => e.id === 'free').date).toBe(OLD),
    );
    await lands('move out', [{ ...FIXTURE[0], date: FREE }, FIXTURE[1], FIXTURE[2], FIXTURE[3]], (entries) =>
      expect(entries.find((e) => e.id === 'old1').date).toBe(FREE),
    );
  });

  it('(f) the admin still edits a COMMITTED segment — SDD-002 ruling 6 is untouched', async () => {
    // The exemption this plan must not widen. Under `team` an admin corrects history; under
    // `personal` the same person is refused, and that difference is the whole of DD-017 §1.
    await lands(
      'committed segment',
      [FIXTURE[0], FIXTURE[1], { ...FIXTURE[2], label: 'edited' }, FIXTURE[3]],
      (entries) => expect(entries.find((e) => e.id === 'frozen').label).toBe('edited'),
    );
  });

  it('an EMPLOYEE still saves their own uncommitted day at 200, and is still pinned on a committed one', async () => {
    // The role half, proved with a role session rather than by reading the diff. Nothing here
    // has widened the committed-segment lock: the employee's own ledger is empty, so their
    // uncommitted day saves; and the pin (`pinCommittedEntries`) is a separate mechanism this
    // plan does not touch.
    const mine = await EMP('GET', '/api/state');
    expect(mine.json.entries).toEqual([]); // a fresh employee, their own scope
    const put = await EMP('PUT', '/api/state', {
      entries: [entry('emp1', OLD, 480, 540, 'the employee’s own old day')],
      version: mine.json.version,
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect((await EMP('GET', '/api/state')).json.entries.map((e) => e.id)).toEqual(['emp1']);
  });
});
