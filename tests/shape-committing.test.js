// SB-056 / DD-008: committing is refused in the personal shape, server-side.
//
// The ledger lives in weekly notes, which are phase 3, so under `personal` there is nowhere to
// persist a commit. The two alternatives were rejected: a SQLite ledger under `personal` is the
// per-machine silent divergence this whole map exists to kill, and moving it into Catalog.md
// now is pre-planning behind fog.
//
// A CONTRAST PAIR, always. A 403 on its own could equally have come from the employee/admin
// split, so every refusal here is made BY AN ADMIN, the message is asserted to name the
// shape, and the identical call is made against a team server and asserted to succeed.
//
// And every refusal re-reads the STORED ledger afterwards: a 403 raised AFTER putCommits would
// look identical from outside the process.
//
// ## Verified red-green: 2026-07-26, RE-RUN by SB-100 under the new names (output TRANSCRIBED
//    from the run, not reconstructed.)
//   Dropping the capability check (commitCapabilityRefusal → `return null`, and the
//   segmentLockHandler guard forced to `const off = null`) — 4 of 6 fail:
//     FAIL  refuses a NEW commit, as the admin, naming the shape — and the stored ledger …
//           AssertionError: expected 200 to be 403
//     FAIL  refuses approve and release
//           AssertionError: expected 200 to be 403
//     FAIL  keeps saving entries at 200 with the pre-switch ledger riding along
//           AssertionError: expected [ '2026-W30-2026-07', …(1) ] to deeply equal [ '2026-W30-2026-07' ]
//     FAIL  refuses UN-committing too — dropping a key is a change to the ledger
//           AssertionError: expected 200 to be 403
//   The third is a CASCADE, not an independent guard: the un-refused commit from the first test
//   is still in the ledger when it re-reads. Named rather than counted as evidence.
//   The team half of every pair stays green throughout, which is what makes it a contrast.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn } from './util.js';

afterAll(stopAllServers);

const DATE = '2026-07-26';
const KEY = TT.segmentKey(DATE);
const OTHER_DATE = '2026-08-11'; // a different ISO week, so a genuinely second segment
const OTHER_KEY = TT.segmentKey(OTHER_DATE);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, md: join(data, 'mirror') };
}

/** Log one hour on `date` and commit its segment. Returns the admin session + user id. */
async function logAndCommit(port, id, date, key) {
  const admin = await adminOn(port);
  const me = await admin('GET', '/api/me');
  const state = await admin('GET', '/api/state');
  const entry = { id, date, start: 540, end: 600, project: null, label: 'gate', note: '', billable: 1 };
  const put = await admin('PUT', '/api/state', {
    entries: [...state.json.entries, entry],
    commits: [...state.json.commits, { key }],
  });
  return { admin, userId: me.json.user.id, put };
}

describe('committing in the team shape (the contrast)', () => {
  it('commits, approves and releases exactly as it always did', async () => {
    const { data, md } = dataDir('commit-team');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const { admin, userId, put } = await logAndCommit(server.port, 'e1-team', DATE, KEY);
    expect(put.status).toBe(200);
    const state = await admin('GET', '/api/state');
    expect(state.json.commits.map((c) => c.key)).toContain(KEY);

    expect((await admin('POST', `/api/users/${userId}/segments/${KEY}/approve`, {})).status).toBe(200);
    expect((await admin('POST', `/api/users/${userId}/segments/${KEY}/release`, {})).status).toBe(200);
    await stopServer(server.child);
  }, 40000);
});

describe('committing in the personal shape', () => {
  // One data dir, committed under `team` and then restarted on `personal` — which is the
  // situation the ride-along exists for, and the only way to have an approvable segment to
  // refuse.
  let PORT;
  let USER_ID;
  let ADMIN;

  beforeAll(async () => {
    const { data, md } = dataDir('commit-personal');
    const team = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const seeded = await logAndCommit(team.port, 'e1-personal', DATE, KEY);
    expect(seeded.put.status).toBe(200);
    USER_ID = seeded.userId;
    await stopServer(team.child);

    const personal = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    PORT = personal.port;
    ADMIN = await adminOn(PORT);
    expect((await ADMIN('GET', '/api/state')).json.shape).toBe('personal');
  }, 60000);

  it('refuses a NEW commit, as the admin, naming the shape — and the stored ledger is untouched', async () => {
    const state = await ADMIN('GET', '/api/state');
    const entry = {
      id: 'e2-personal',
      date: OTHER_DATE,
      start: 540,
      end: 600,
      project: null,
      label: 'gate',
      note: '',
      billable: 1,
    };
    const put = await ADMIN('PUT', '/api/state', {
      entries: [...state.json.entries, entry],
      commits: [...state.json.commits, { key: OTHER_KEY }],
    });
    expect(put.status).toBe(403);
    // NOT just the status: an admin session cannot be 403'd by the employee/admin split, and
    // the message has to say which shape and why, because it reaches the user via the toast.
    expect(put.json.error).toMatch(/personal shape/);
    expect(put.json.error).toMatch(/weekly notes/);

    // Re-read: a 403 raised AFTER putCommits would look identical from outside.
    const after = await ADMIN('GET', '/api/state');
    expect(after.json.commits.map((c) => c.key)).toEqual([KEY]);
  });

  it('refuses approve and release', async () => {
    const approve = await ADMIN('POST', `/api/users/${USER_ID}/segments/${KEY}/approve`, {});
    expect(approve.status).toBe(403);
    expect(approve.json.error).toMatch(/personal shape/);

    const release = await ADMIN('POST', `/api/users/${USER_ID}/segments/${KEY}/release`, {});
    expect(release.status).toBe(403);
    expect(release.json.error).toMatch(/personal shape/);

    // Neither lock stamp landed.
    const after = await ADMIN('GET', '/api/state');
    const segment = after.json.commits.find((c) => c.key === KEY);
    expect(segment.approvedAt).toBeUndefined();
    expect(segment.releasedBy).toBeUndefined();
  });

  it('keeps saving entries at 200 with the pre-switch ledger riding along', async () => {
    // THE POINT OF COMPARING RATHER THAN REJECTING. `useServerSync` re-queues any non-409 and
    // re-arms a 4 s timer forever, so a blanket 403 on `commits` would put this install — one
    // that committed a week before the switch — into a permanent toast loop on every hour it
    // logs. The client re-sends the whole ledger on every debounce; here is that debounce.
    const state = await ADMIN('GET', '/api/state');
    // The new hour is logged on a day WELL AFTER the cutover and in no committed segment. That
    // is not incidental: PLAN-015/DD-017 §1 makes a frozen day read-only under `personal`, so
    // adding a row to `DATE` — which is inside the committed segment this suite freezes — is now
    // a 403 from a different guard entirely (`frozenEntryRefusal`, proved in shape-freeze). This
    // case is about the LEDGER riding along, and it has to keep being about only that.
    const entry = {
      id: 'e3-personal',
      date: TT.addDays(TT.todayStr(), 21),
      start: 660,
      end: 720,
      project: null,
      label: 'rides along',
      note: '',
      billable: 1,
    };
    const put = await ADMIN('PUT', '/api/state', {
      entries: [...state.json.entries, entry],
      commits: state.json.commits, // unchanged key set
    });
    expect(put.status).toBe(200);
    const after = await ADMIN('GET', '/api/state');
    expect(after.json.commits.map((c) => c.key)).toEqual([KEY]);

    // A PUT with no `commits` at all is likewise fine — the ledger is simply untouched.
    const bare = await ADMIN('PUT', '/api/state', { entries: after.json.entries });
    expect(bare.status).toBe(200);
  });

  it('the admin cross-user edit corrects the entry but leaves the frozen ledger alone', async () => {
    // END-GATE REVIEW FINDING: the THIRD ledger-write site. `PUT /api/users/:id/entries`
    // RE-FREEZES the money snapshot of any committed segment it touches, and the first pass
    // gated only PUT /api/state and the lock verbs — so under `personal` an admin correcting an
    // hour inside a pre-switch committed week still rewrote a ledger the shape is declared
    // unable to hold. Reachable today: under `personal` the single user IS an admin, and the
    // Review surface is not otherwise gated.
    //
    // The ENTRY edit still lands. Refusing it would wedge an admin out of correcting any week
    // that was ever committed — the same failure the ride-along exists to prevent. It is the
    // ledger that is frozen, not the timesheet.
    const before = await ADMIN('GET', '/api/state');
    const frozen = before.json.commits.find((c) => c.key === KEY);
    const target = before.json.entries.find((e) => e.id === 'e1-personal');
    expect(frozen.snapshot[target.id]).toBeTruthy();

    const edited = { ...target, label: 'corrected by admin', end: 660 };
    const put = await ADMIN('PUT', `/api/users/${USER_ID}/entries`, {
      entries: before.json.entries.map((e) => (e.id === target.id ? edited : e)),
    });
    expect(put.status).toBe(200);

    const after = await ADMIN('GET', '/api/state');
    // the correction really landed…
    const corrected = after.json.entries.find((e) => e.id === target.id);
    expect(corrected.label).toBe('corrected by admin');
    expect(corrected.end).toBe(660);
    // …and the frozen money did NOT move. Asserting only the 200 would pass against the bug.
    const stillFrozen = after.json.commits.find((c) => c.key === KEY);
    expect(stillFrozen.snapshot).toEqual(frozen.snapshot);
  });

  it('refuses UN-committing too — dropping a key is a change to the ledger', async () => {
    const put = await ADMIN('PUT', '/api/state', { commits: [] });
    expect(put.status).toBe(403);
    expect(put.json.error).toMatch(/personal shape/);
    const after = await ADMIN('GET', '/api/state');
    expect(after.json.commits.map((c) => c.key)).toEqual([KEY]);
  });
});
