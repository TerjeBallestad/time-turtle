// Old days and committed segments take edits under the ordinary commit rule.
//
// Every call here edits, adds, deletes or moves an hour on a day 30 days back or inside a
// committed segment, as the admin, and asserts it answers 200 AND lands in storage. An admin
// corrects committed history (SDD-002 ruling 6); an employee saves their own uncommitted day.
//
// Moved from shape-freeze.test.js when the shape concept was removed (SB-181): these were its
// `team` contrast cases, and they lost only the shape assertion in the seed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn, session } from './util.js';

afterAll(stopAllServers);

const TODAY = TT.todayStr();
const OLD = TT.addDays(TODAY, -30);
const FREE = TT.addDays(TODAY, 7); // in no committed segment
/** The segment containing today — committed by the seed. */
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
 * Four entries:
 *   old1/old2 — two rows on a day 30 days back
 *   frozen    — TODAY, inside the segment committed below
 *   free      — a week out, in no committed segment
 */
const FIXTURE = [
  entry('old1', OLD, 480, 540, 'an hour from before'),
  entry('old2', OLD, 540, 600, 'a second hour from before'),
  entry('frozen', TODAY, 600, 660, 'inside the committed week'),
  entry('free', FREE, 660, 720, 'an ordinary hour'),
];

function dataDir(label) {
  return mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
}

/** Seed FIXTURE and commit today's segment. */
async function seed(port) {
  const admin = await adminOn(port);
  const state = await admin('GET', '/api/state');
  const put = await admin('PUT', '/api/state', {
    entries: FIXTURE,
    commits: [{ key: SEGMENT.key }],
    version: state.json.version,
  });
  expect(put.status).toBe(200);
  return admin;
}

describe('old days and committed segments take edits under the ordinary commit rule', () => {
  let ADMIN = null;
  let EMP = null;
  let child = null;

  beforeAll(async () => {
    const team = await startServer({ TT_DATA_DIR: dataDir('old-day-edits'), TT_SEED_DEMO: '0' });
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

  /** The mutation answers 200, and it actually LANDS. */
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
    // The exemption: an admin corrects committed history.
    await lands(
      'committed segment',
      [FIXTURE[0], FIXTURE[1], { ...FIXTURE[2], label: 'edited' }, FIXTURE[3]],
      (entries) => expect(entries.find((e) => e.id === 'frozen').label).toBe('edited'),
    );
  });

  it('an EMPLOYEE still saves their own uncommitted day at 200, and is still pinned on a committed one', async () => {
    // The role half, proved with a role session rather than by reading the diff. The employee's
    // own ledger is empty, so their uncommitted day saves; the pin (`pinCommittedEntries`) is a
    // separate mechanism.
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
