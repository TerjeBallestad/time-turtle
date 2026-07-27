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
//
// ## Verified red-green: 2026-07-27, SB-149's guard (output TRANSCRIBED from the run.)
//   Dropping the two-line `frozenEntryRefusal` call from `PUT /api/users/:id/entries` — 1 fails:
//     FAIL  refuses the admin cross-user edit of a frozen day — the back door is shut (SB-149)
//           AssertionError: expected 200 to be 403
//   The 200 is the pre-SB-149 behaviour exactly, which is what makes this case the guard's and
//   not a cascade of the capability check above it.
//
// ## Verified red-green: 2026-07-27, SB-149 must-fix 2 — the LEDGER BELT (output TRANSCRIBED.)
//   The case above was rewritten on the premise that no personal-shape path still reaches the
//   `commitsChanged && !shapeOffReason('committing', …)` line in `index.js`, and that premise is
//   false (SB-164). Dropping the clause — `if (commitsChanged) store.putCommits(id, reFrozen);` —
//   over the FULL suite, 1 fails, and it is the restored case and nothing else:
//     FAIL  a durMin-only edit reaches the re-freeze line, and the belt keeps the ledger frozen
//           AssertionError: expected { …(8) } to deeply equal { …(8) }
//           -     "billMin": 60,
//           +     "billMin": 999,
//     Tests  1 failed | 814 passed (815)
//   Hours moved and the frozen money followed them — the DD-017 §2 divergence the clause exists
//   to prevent. Measured at c35eddf BEFORE this fix, the same deletion changed nothing anywhere
//   in the suite: the clause had no coverage at all.
//
// ## Measured, not asserted: which clause refuses in the case above (SB-149 preference)
//   `readOnlyDay` under `personal` is `preCutover(date) || frozenSegment(date)`, and `DATE` is
//   pre-cutover — so `preCutover` short-circuits and the committed-segment half never runs.
//   Forcing `TT.frozenSegment` to `return false` leaves this whole file GREEN (7 passed), which
//   is why the case now asserts `target.date < cutoverDay` and labels `committedOn` as true but
//   not the thing that refuses. The frozen-segment clause's real coverage is
//   `tests/shape-freeze.test.js` case (f), on a POST-cutover day.
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

  it('refuses the admin cross-user edit of a frozen day — the back door is shut (SB-149)', async () => {
    // WAS: 'the admin cross-user edit corrects the entry but leaves the frozen ledger alone',
    // asserting a 200. SB-149 (ruled 2026-07-27) reversed that for `personal`: DD-017 §1 makes
    // editable ⇔ vault-bound, so the timesheet is frozen too and `PUT /api/users/:id/entries`
    // now consults `frozenEntryRefusal` like the self path does.
    //
    // NOT re-scoped, rewritten — deliberately. The old case proved the ledger claim BY editing an
    // entry inside a committed segment; once that 403s under `personal` the claim cannot be
    // asserted the same way here. The team half of it — an admin correction re-freezing only the
    // segment it touched — is covered at `tests/api.test.js` ('admin corrects a committed line:
    // re-freezes ONLY that segment…' and the partial-re-freeze case below it), which runs the
    // default `team` shape.
    //
    // AN EARLIER VERSION OF THIS COMMENT WENT FURTHER AND WAS WRONG. It said "there is no
    // personal-shape path left that reaches the re-freeze code at all", and the rewrite traded
    // away that clause's only red-green on that premise. SB-164 is the standing counterexample —
    // a `durMin`-only edit walks through the guard and reaches the line — so the coverage is
    // restored in the case below rather than left to the premise.
    //
    // A 403 protects the ledger MORE strongly than the old assertion did: the old one let the
    // write land and checked the snapshot afterwards, this one never lets it land.
    const before = await ADMIN('GET', '/api/state');
    const frozen = before.json.commits.find((c) => c.key === KEY);
    const target = before.json.entries.find((e) => e.id === 'e1-personal');
    // The fixture has to actually be frozen, or the case is vacuous against any implementation.
    //
    // NAMING THE CLAUSE THAT ACTUALLY FIRES. `readOnlyDay` under `personal` is
    // `preCutover(date) || frozenSegment(date)`, and `DATE` is before the cutover the personal
    // boot stamps — so `preCutover` short-circuits and the committed-segment half never runs.
    // Asserting only `committedOn` here read as "this case covers the frozen-segment clause",
    // which it does not: forcing `TT.frozenSegment` to return false leaves this whole file green.
    // Both are asserted so the reader can see which one is load-bearing. The frozen-segment
    // clause's real coverage is `tests/shape-freeze.test.js` case (f), on a POST-cutover day.
    const cutoverDay = (await ADMIN('GET', '/api/state')).json.settings.vaultCutover.slice(0, 10);
    expect(target.date < cutoverDay).toBe(true); // ← the clause this case actually exercises
    expect(frozen.snapshot[target.id]).toBeTruthy();
    expect(TT.committedOn(target.date, before.json.commits)).toBe(true); // true, but not what refuses

    const edited = { ...target, label: 'corrected by admin', end: 660 };
    const put = await ADMIN('PUT', `/api/users/${USER_ID}/entries`, {
      entries: before.json.entries.map((e) => (e.id === target.id ? edited : e)),
    });
    expect(put.status).toBe(403);
    // An ADMIN session cannot be 403'd by the employee/admin split, so the message has to name
    // the freeze rather than a role — the same refusal string the self path returns.
    expect(put.json.error).toBe(TT.FROZEN_ENTRY_REFUSAL);

    const after = await ADMIN('GET', '/api/state');
    // Neither half moved. A guard that ran AFTER putEntries would look identical from outside.
    const untouched = after.json.entries.find((e) => e.id === target.id);
    expect(untouched.label).toBe(target.label);
    expect(untouched.end).toBe(target.end);
    const stillFrozen = after.json.commits.find((c) => c.key === KEY);
    expect(stillFrozen.snapshot).toEqual(frozen.snapshot);
  });

  // THE BELT'S OWN RED-GREEN, restored (SB-149 must-fix 2).
  //
  // `index.js`'s ledger write is `if (commitsChanged && !TT.shapeOffReason('committing', …))`.
  // The rewrite of the case above deleted the only test that reached that line under `personal`,
  // on the premise that the new guard made it unreachable. The premise is false, and this case is
  // the proof: it drives the request that reaches it and pins what the clause does when it gets
  // there. Measured at `c35eddf`, deleting the clause (`if (commitsChanged) store.putCommits(…)`)
  // changed nothing anywhere in the suite.
  //
  // THIS CASE IS COUPLED TO SB-164 ON PURPOSE, and says so in its assertions. The lever is the
  // SB-164 hole itself — `TT.entryMatchKey` keys `range:<start>-<end>` and never reads `durMin`,
  // so a `durMin`-only edit is invisible to `frozenEntryRefusal` while `entryDiffers`
  // (`ENTRY_FIELDS`) sees it and marks the segment affected. When SB-164 lands the 200 below
  // becomes a 403 and this case fails loudly. THAT IS THE INTENDED SIGNAL, not a regression:
  // at that point no entry in a committed segment can change under `personal` at all, so
  // `commitsChanged` cannot be true, the clause is dead rather than protective, and the right
  // move is to DELETE both the clause and this case. Do not repair it into a passing test.
  it('a durMin-only edit reaches the re-freeze line, and the belt keeps the ledger frozen (SB-149 must-fix 2)', async () => {
    const before = await ADMIN('GET', '/api/state');
    const frozen = before.json.commits.find((c) => c.key === KEY);
    const target = before.json.entries.find((e) => e.id === 'e1-personal');
    expect(frozen.snapshot[target.id]).toBeTruthy(); // the fixture is genuinely frozen money
    expect(target.start).not.toBe(null); // the range branch of entryMatchKey is the one with the hole
    expect(target.end).not.toBe(null);

    // Only `durMin` moves. Same id, same date, same start/end, same label — so the row's
    // `entryMatchKey` is byte-identical and the guard sees no change.
    const edited = { ...target, durMin: 999 };
    const put = await ADMIN('PUT', `/api/users/${USER_ID}/entries`, {
      entries: before.json.entries.map((e) => (e.id === target.id ? edited : e)),
    });
    expect(put.status).toBe(200); // ← SB-164. Becomes 403 when it lands; see the note above.

    const after = await ADMIN('GET', '/api/state');
    // The write really landed, so the segment really was `affected` and `commitsChanged` really
    // was true. Without this the snapshot assertion below could pass on a request that never got
    // near the line it claims to cover.
    expect(after.json.entries.find((e) => e.id === target.id).durMin).toBe(999);

    // …and the belt held: the ledger was NOT re-frozen around the moved hours. This is the
    // assertion that goes red if the `shapeOffReason` clause is dropped — the snapshot would
    // re-derive and `billMin` would follow `durMin` instead of staying at the committed 60.
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
