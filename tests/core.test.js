// Unit tests over shared/core.js — pure logic: time parsing, ISO weeks,
// billing rounding, overnight rollover, and the display formatters.
//
// ## Verified red-green: 2026-07-23
// PLAN-007 (SB-025): monthSegments/monthGood/segmentApproved review rollup.
// ## Verified red-green: 2026-07-24
//
// ## Verified red-green: 2026-07-27
// PLAN-015 (SB-102 / DD-017 §1): the read-only rule. Output TRANSCRIBED from the runs.
//   (a) `TT.frozenSegment` forced to `return false` — the ledger clause gone. 3 table rows fail:
//         × personal / cutover 2026-07-15T09:12:33.000Z / ledger / employee / 2026-07-20
//           AssertionError: expected [ false, false, false ] to deeply equal [ false, true, true ]
//       (the complement assertion does NOT fail here, and that is correct: `readOnlyDay` and
//       `vaultBound` both compose the same broken helper, so they stay complements. The thing
//       that catches it is the table, and — end to end — the vault case in vault-write.test.js.)
//   (b) `readOnlyDay`'s personal branch re-derived as `return TT.frozenSegment(date, ctx)`,
//       i.e. it stops deriving and disagrees with `vaultBound`. 4 fail, and the invariant is
//       the one that names it:
//         × under `personal`, readOnlyDay is the EXACT complement of vaultBound on every row
//           AssertionError: personal / cutover 2026-07-15T09:12:33.000Z / no ledger / employee /
//           2026-07-14: expected false to be true
//   (c) `preCutover`'s date comparison replaced by `return false`. 3 table rows fail, plus
//       vault-write's pre-existing case (2):
//         × (2) an entry dated BEFORE the cutover produces no file and no adoption
//           AssertionError: a pre-cutover day was given a daily note: expected true to be false
//   Restored: 129 passed across the two files.
import { describe, it, expect } from 'vitest';
import TT from '../shared/core.js';

describe('parseTimeCell', () => {
  it('parses ranges in the various accepted notations', () => {
    expect(TT.parseTimeCell('9-17')).toEqual({ kind: 'range', start: 540, end: 1020 });
    expect(TT.parseTimeCell('09:00-17:00')).toEqual({ kind: 'range', start: 540, end: 1020 });
    expect(TT.parseTimeCell('0930-1745')).toEqual({ kind: 'range', start: 570, end: 1065 });
    // arrow / en-dash / "to" separators all normalize
    expect(TT.parseTimeCell('9→17')).toEqual({ kind: 'range', start: 540, end: 1020 });
    expect(TT.parseTimeCell('9 to 17')).toEqual({ kind: 'range', start: 540, end: 1020 });
  });

  it('parses running (open-ended) entries', () => {
    expect(TT.parseTimeCell('12:30>')).toEqual({ kind: 'running', start: 750 });
    expect(TT.parseTimeCell('12:30-')).toEqual({ kind: 'running', start: 750 });
  });

  it('parses durations including the "t" (timer) hour suffix and decimals', () => {
    expect(TT.parseTimeCell('5h')).toEqual({ kind: 'duration', min: 300 });
    expect(TT.parseTimeCell('1h30m')).toEqual({ kind: 'duration', min: 90 });
    expect(TT.parseTimeCell('45m')).toEqual({ kind: 'duration', min: 45 });
    expect(TT.parseTimeCell('1.5h')).toEqual({ kind: 'duration', min: 90 });
    expect(TT.parseTimeCell('8t')).toEqual({ kind: 'duration', min: 480 });
    // comma is normalized to a decimal point
    expect(TT.parseTimeCell('1,5h')).toEqual({ kind: 'duration', min: 90 });
  });

  it('rejects garbage', () => {
    expect(TT.parseTimeCell('abc')).toBeNull();
    expect(TT.parseTimeCell('')).toBeNull();
    expect(TT.parseTimeCell('   ')).toBeNull();
    expect(TT.parseTimeCell('99:99')).toBeNull();
  });

  it('accepts the 24:00 edge but rejects 24:01', () => {
    expect(TT.parseTimeCell('00:00-24:00')).toEqual({ kind: 'range', start: 0, end: 1440 });
    expect(TT.parseTimeCell('00:00-24:01')).toBeNull();
    expect(TT.parseTimeCell('24:01>')).toBeNull();
  });
});

describe('isoWeek', () => {
  it('handles year boundaries (weeks that belong to the neighbouring year)', () => {
    expect(TT.isoWeek('2026-01-01')).toEqual({ week: 1, year: 2026 });
    // Mon 2025-12-29 belongs to ISO week 1 of 2026
    expect(TT.isoWeek('2025-12-29')).toEqual({ week: 1, year: 2026 });
    // Fri 2021-01-01 belongs to ISO week 53 of 2020
    expect(TT.isoWeek('2021-01-01')).toEqual({ week: 53, year: 2020 });
    // 2023-01-01 (Sunday) belongs to ISO week 52 of 2022
    expect(TT.isoWeek('2023-01-01')).toEqual({ week: 52, year: 2022 });
  });

  it('handles a mid-year date', () => {
    expect(TT.isoWeek('2026-07-23')).toEqual({ week: 30, year: 2026 });
  });
});

// SDD-002 ruling 4: the commit unit is an (ISO week ∩ calendar month) segment.
// A month-straddling week has two independently committable segments.
// ## Verified red-green: 2026-07-24
describe('segmentKey', () => {
  it('keys by ISO week-year + week + the calendar month of the date', () => {
    expect(TT.segmentKey('2026-07-24')).toBe('2026-W30-2026-07'); // Fri, ISO week 30
    expect(TT.segmentKey('2026-07-08')).toBe('2026-W28-2026-07');
  });

  it('uses the ISO week-YEAR (not the calendar year) for a boundary week', () => {
    // Wed 2025-12-31 is in ISO week 1 of 2026, but the calendar month is 2025-12.
    expect(TT.segmentKey('2025-12-31')).toBe('2026-W01-2025-12');
    // Thu 2026-01-01 is the same ISO week, but the month rolls to 2026-01.
    expect(TT.segmentKey('2026-01-01')).toBe('2026-W01-2026-01');
  });
});

describe('weekSegments', () => {
  it('splits a month-straddling week into exactly two segments, in day order', () => {
    // Week of 2026-07-30: Mon 2026-07-27 .. Sun 2026-08-02 crosses Jul→Aug.
    const segs = TT.weekSegments('2026-07-30');
    expect(segs.map((s) => s.key)).toEqual(['2026-W31-2026-07', '2026-W31-2026-08']);
    expect(segs[0]).toMatchObject({
      month: '2026-07',
      dates: ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'],
    });
    expect(segs[1]).toMatchObject({ month: '2026-08', dates: ['2026-08-01', '2026-08-02'] });
    // every day of the week is accounted for, exactly once
    expect(segs.flatMap((s) => s.dates)).toHaveLength(7);
  });

  it('yields a single segment for a week wholly inside one month', () => {
    const segs = TT.weekSegments('2026-07-08'); // Mon 2026-07-06 .. Sun 2026-07-12
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ key: '2026-W28-2026-07', month: '2026-07', dates: TT.weekDates('2026-07-08') });
  });

  it('a Dec/Jan week straddles both year and month yet still yields exactly two', () => {
    const segs = TT.weekSegments('2025-12-31'); // ISO week 1 of 2026, spanning Dec25→Jan26
    expect(segs.map((s) => s.key)).toEqual(['2026-W01-2025-12', '2026-W01-2026-01']);
  });
});

// SDD-002 ruling 8: snapshot-preferring readers return the FROZEN money for a committed
// entry and the LIVE money otherwise — a rate renegotiation must never move committed money.
describe('snapshot-preferring billing readers', () => {
  const build = () => ({
    settings: { currency: 'kr', language: 'en' },
    clients: [{ id: 'c1', name: 'C1', rounding: 'exact', rate: null }],
    projects: [{ code: 'P1', name: 'P1', clientId: 'c1', rate: 1000, billable: true }],
    tasks: [],
    entries: [
      {
        id: 'eX',
        date: '2026-07-24',
        start: 540,
        end: 600,
        durMin: null,
        project: 'P1',
        label: 'x',
        note: '',
        billable: true,
      },
    ],
    commits: [],
  });

  it('reads the frozen snapshot for a committed entry, unchanged when the project rate later changes', () => {
    const state = build();
    const e = state.entries[0];
    // sanity: live money before commit (60 min @ 1000/h = 1000)
    expect(TT.amount(state, e)).toBe(1000);
    expect(TT.billMinutes(state, e)).toBe(60);
    // commit the segment, freezing the money at the current rate
    state.commits = [
      {
        key: TT.segmentKey(e.date),
        committedAt: '2026-07-24T10:00:00.000Z',
        snapshot: { eX: { rate: 1000, billMin: 60, amount: 1000 } },
      },
    ];
    // now renegotiate the rate upward — LIVE money moves, FROZEN money must not
    state.projects[0].rate = 5000;
    expect(TT.amount(state, e)).toBe(5000); // live reader follows the new rate
    expect(TT.effectiveAmount(state, e)).toBe(1000); // frozen snapshot wins
    expect(TT.effectiveBillMinutes(state, e)).toBe(60);
    expect(TT.commitSnapshot(state, e)).toEqual({ rate: 1000, billMin: 60, amount: 1000 });
  });

  it('falls back to live money for an entry whose segment is not committed', () => {
    const state = build();
    state.projects[0].rate = 5000;
    // an entry in a DIFFERENT (uncommitted) month
    const e2 = {
      id: 'eY',
      date: '2026-08-15',
      start: 540,
      end: 600,
      durMin: null,
      project: 'P1',
      label: 'y',
      note: '',
      billable: true,
    };
    state.entries.push(e2);
    state.commits = [
      {
        key: TT.segmentKey('2026-07-24'),
        committedAt: '2026-07-24T10:00:00.000Z',
        snapshot: { eX: { rate: 1000, billMin: 60, amount: 1000 } },
      },
    ];
    expect(TT.commitSnapshot(state, e2)).toBeNull();
    expect(TT.effectiveAmount(state, e2)).toBe(5000); // live
    expect(TT.effectiveBillMinutes(state, e2)).toBe(60);
  });

  it('falls back to live when there are no commits at all', () => {
    const state = build();
    const e = state.entries[0];
    expect(TT.commitSnapshot(state, e)).toBeNull();
    expect(TT.effectiveAmount(state, e)).toBe(TT.amount(state, e));
  });
});

// SDD-002 rulings 4/5 (SB-025): the review rollup — per (week ∩ month) segment status a
// month, reused by the admin review pills and the awaiting-approval nav badge.
describe('monthSegments / monthGood / segmentApproved review rollup', () => {
  // Two ISO weeks of Jan 2026, both fully inside the month: W02 (Jan 5-11) and W03 (Jan 12-18).
  const build = () => ({
    settings: { currency: 'kr', language: 'en' },
    clients: [],
    projects: [],
    tasks: [],
    entries: [
      {
        id: 'a',
        date: '2026-01-05',
        start: 540,
        end: 600,
        durMin: null,
        project: null,
        label: '',
        note: '',
        billable: true,
      },
      {
        id: 'b',
        date: '2026-01-12',
        start: 540,
        end: 600,
        durMin: null,
        project: null,
        label: '',
        note: '',
        billable: true,
      },
      // an entry in a DIFFERENT month — must never appear in Jan's rollup
      {
        id: 'c',
        date: '2026-02-02',
        start: 540,
        end: 600,
        durMin: null,
        project: null,
        label: '',
        note: '',
        billable: true,
      },
    ],
    commits: [],
  });
  const W02 = '2026-W02-2026-01';
  const W03 = '2026-W03-2026-01';

  it('classifies a mixed month: one committed+approved, one committed-not-approved, one open', () => {
    const state = build();
    // add a THIRD week's entry so we have an open (uncommitted) segment too
    state.entries.push({
      id: 'd',
      date: '2026-01-19',
      start: 540,
      end: 600,
      durMin: null,
      project: null,
      label: '',
      note: '',
      billable: true,
    });
    const W04 = '2026-W04-2026-01';
    state.commits = [
      { key: W02, committedAt: '2026-01-15T10:00:00.000Z', snapshot: {}, approvedAt: '2026-01-20T08:00:00.000Z' },
      { key: W03, committedAt: '2026-01-15T10:00:00.000Z', snapshot: {} }, // committed, not approved
      // W04 left uncommitted
    ];
    const segs = TT.monthSegments(state, '2026-01');
    expect(segs).toEqual([
      { key: W02, committed: true, approved: true },
      { key: W03, committed: true, approved: false },
      { key: W04, committed: false, approved: false },
    ]);
    // a mixed month with an open segment is NOT good
    expect(TT.monthGood(state, '2026-01')).toBe(false);
    // count of segments awaiting approval (committed && !approved) — the nav badge number
    expect(segs.filter((s) => s.committed && !s.approved).length).toBe(1);
  });

  it('a fully-committed month is good; approval is an overlay on top of committed', () => {
    const state = build();
    state.commits = [
      { key: W02, committedAt: '2026-01-15T10:00:00.000Z', snapshot: {}, approvedAt: '2026-01-20T08:00:00.000Z' },
      { key: W03, committedAt: '2026-01-15T10:00:00.000Z', snapshot: {} },
    ];
    expect(TT.monthGood(state, '2026-01')).toBe(true);
    // February (only the uncommitted entry c) is not good
    expect(TT.monthGood(state, '2026-02')).toBe(false);
  });

  it('a released segment reads as committed-but-not-approved (segmentApproved false)', () => {
    const released = { key: W02, committedAt: 'x', snapshot: {}, releasedBy: 7 };
    expect(TT.segmentApproved(released)).toBe(false);
    expect(TT.segmentApproved({ key: W02, committedAt: 'x', snapshot: {}, approvedAt: 'y' })).toBe(true);
    expect(TT.segmentApproved(null)).toBe(false);
    expect(TT.segmentApproved(undefined)).toBe(false);
  });

  it('a month with no entries is vacuously good and has no segments', () => {
    const state = build();
    expect(TT.monthSegments(state, '2026-12')).toEqual([]);
    expect(TT.monthGood(state, '2026-12')).toBe(true);
  });
});

// SDD-002 ruling 7: archiving hides an item from creation pickers (a client concern),
// but the shared resolvers MUST keep resolving archived clients/projects so old reports
// and invoices are unchanged — history works forever. Proven here as pure logic.
// ## Verified red-green: 2026-07-24
describe('resolvers ignore the archived flag (history resolves forever)', () => {
  const state = {
    settings: { currency: 'kr', language: 'en' },
    clients: [{ id: 'oldco', name: 'Old Co', rounding: 15, rate: 800, archived: true }],
    projects: [
      { code: 'OLD-GIG', name: 'Retired gig', clientId: 'oldco', rate: 900, billable: true, archived: true },
      { code: 'OLD-NB', name: 'Retired nb', clientId: 'oldco', rate: null, billable: false, archived: true },
    ],
    tasks: [],
    entries: [],
  };
  const entry = (over) => ({
    project: 'OLD-GIG',
    label: 'x',
    note: '',
    durMin: 50,
    start: null,
    end: null,
    billable: true,
    ...over,
  });

  it('projectOf / clientOf resolve an archived project and its archived client', () => {
    const p = TT.projectOf(state, 'OLD-GIG');
    expect(p).toMatchObject({ code: 'OLD-GIG', archived: true });
    expect(TT.clientOf(state, p)).toMatchObject({ id: 'oldco', archived: true });
  });

  it('rateOf resolves an archived project rate (and its archived-client fallback)', () => {
    expect(TT.rateOf(state, 'OLD-GIG')).toBe(900); // project rate
    expect(TT.rateOf(state, 'OLD-NB')).toBe(800); // falls back to the archived client's rate
  });

  it('projectBillable still reads the archived project’s own default', () => {
    expect(TT.projectBillable(state, 'OLD-GIG')).toBe(true);
    expect(TT.projectBillable(state, 'OLD-NB')).toBe(false);
  });

  it('billMinutes / amount cost an archived project exactly as if it were active', () => {
    expect(TT.billMinutes(state, entry())).toBe(60); // 50 min → 15-min rounding → 60
    expect(TT.amount(state, entry())).toBe(900); // 1h billed × 900
  });
});

describe('roundBill', () => {
  it('leaves minutes untouched when rounding is exact/zero', () => {
    expect(TT.roundBill(50, 'exact')).toBe(50);
    expect(TT.roundBill(50, 0)).toBe(50);
  });

  it('rounds up to the nearest 15 or 30', () => {
    expect(TT.roundBill(50, 15)).toBe(60);
    expect(TT.roundBill(45, 15)).toBe(45); // already on the boundary
    expect(TT.roundBill(50, 30)).toBe(60);
    expect(TT.roundBill(31, 30)).toBe(60);
  });

  it('never rounds non-positive minutes up', () => {
    expect(TT.roundBill(0, 15)).toBe(0);
  });
});

// SDD-002: an entry inherits its billable flag from the PROJECT it is logged
// against (superseding SB-011's task-level default). This is the resolution helper
// both sides derive from at the entry-birth moment.
describe('projectBillable', () => {
  const state = {
    projects: [
      { code: 'FJH-NETT', name: 'Nettbutikk', clientId: null, rate: null, billable: true },
      { code: 'INT-ADM', name: 'Internal admin', clientId: null, rate: null, billable: false },
    ],
  };

  it('resolves a project to its own default', () => {
    expect(TT.projectBillable(state, 'FJH-NETT')).toBe(true);
    expect(TT.projectBillable(state, 'INT-ADM')).toBe(false);
  });

  it('is billable when there is no project, or the project is unknown', () => {
    expect(TT.projectBillable(state, null)).toBe(true);
    expect(TT.projectBillable(state, 'ghost')).toBe(true);
  });

  it('treats a project with no stored default as billable (pre-SDD-002 rows)', () => {
    expect(TT.projectBillable({ projects: [{ code: 'X', name: 'X', clientId: null, rate: null }] }, 'X')).toBe(true);
  });
});

// SDD-002: entries own their project code directly (copied at birth). The billing
// helpers read it off the entry — no task lookup.
describe('entryProjectCode + billing read the entry-owned project', () => {
  const state = {
    settings: { currency: 'kr', language: 'en' },
    clients: [{ id: 'fjellheim', name: 'Fjellheim', rounding: 15, rate: 1200 }],
    projects: [{ code: 'FJH-NETT', name: 'Nett', clientId: 'fjellheim', rate: null, billable: true }],
    tasks: [],
    entries: [],
  };
  const entry = (over) => ({
    project: 'FJH-NETT',
    label: 'x',
    note: '',
    durMin: 50,
    start: null,
    end: null,
    billable: true,
    ...over,
  });

  it('entryProjectCode returns the copied project, not a task lookup', () => {
    expect(TT.entryProjectCode(state, entry())).toBe('FJH-NETT');
    expect(TT.entryProjectCode(state, entry({ project: null }))).toBe(null);
  });

  it('billMinutes rounds via the project’s client and respects billable', () => {
    expect(TT.billMinutes(state, entry())).toBe(60); // 50 min → 15-min rounding → 60
    expect(TT.billMinutes(state, entry({ billable: false }))).toBe(0);
  });

  it('amount uses the resolved (client-fallback) rate over billed hours', () => {
    expect(TT.amount(state, entry())).toBe(1200); // 1h billed × 1200
  });
});

describe('entryMinutes', () => {
  it('returns the stored duration for duration entries', () => {
    expect(TT.entryMinutes({ durMin: 90, start: null, end: null })).toBe(90);
  });

  it('rolls overnight ranges (end < start) into the next day', () => {
    // 23:00 -> 02:00 = 3h
    expect(TT.entryMinutes({ durMin: null, start: 1380, end: 120 })).toBe(180);
  });

  it('computes a normal same-day range', () => {
    expect(TT.entryMinutes({ durMin: null, start: 540, end: 1020 })).toBe(480);
  });

  it('returns 0 when there is no start', () => {
    expect(TT.entryMinutes({ durMin: null, start: null, end: null })).toBe(0);
  });
});

describe('formatters', () => {
  it('fmtTimeCell renders duration, range, running and empty entries', () => {
    expect(TT.fmtTimeCell({ durMin: 90 })).toBe('1h30m');
    expect(TT.fmtTimeCell({ durMin: null, start: 540, end: 1020 })).toBe('09:00→17:00');
    expect(TT.fmtTimeCell({ durMin: null, start: 750, end: null })).toBe('12:30→');
    expect(TT.fmtTimeCell({ durMin: null, start: null, end: null })).toBe('');
  });

  it('fmtDur combines hours and minutes', () => {
    expect(TT.fmtDur(90)).toBe('1h30m');
    expect(TT.fmtDur(300)).toBe('5h');
    expect(TT.fmtDur(45)).toBe('45m');
    expect(TT.fmtDur(0)).toBe('0m');
  });

  it('fmtHours renders decimal hours', () => {
    expect(TT.fmtHours(90)).toBe('1.5');
    expect(TT.fmtHours(30)).toBe('0.5');
    expect(TT.fmtHours(100)).toBe('1.67');
  });

  it('fmtMoney thin-space-groups thousands and appends the currency', () => {
    // groups are separated by U+2009 THIN SPACE; the currency by a normal space
    const T = '\u2009';
    expect(TT.fmtMoney(1234)).toBe(`1${T}234 kr`);
    expect(TT.fmtMoney(1000000, 'kr')).toBe(`1${T}000${T}000 kr`);
    expect(TT.fmtMoney(500, 'USD')).toBe('500 USD');
  });
});

// ## Verified red-green: 2026-07-26
// SB-088: ONE slug rule. `TT.slug` dropped the Nordic letters outright — "Bærum" came out
// `b-rum` — while `makeClientId` (SB-067) transliterated them, so the two rules disagreed
// about the language most of this catalog is written in. The transliteration now lives in
// `TT.slug` and `makeClientId` calls it.
//
// This changes what NEW ids look like ONLY. Nothing stored is re-derived or renamed by this
// change: an existing project code, client id or task id keeps exactly the bytes it has.
//
// The ASCII rows are the CONTROL — they were green before the fix and must stay green, which
// is what proves slugging in general was not changed, only extended.
describe('TT.slug transliterates rather than dropping (SB-088)', () => {
  const NORDIC = [
    ['Bærum', 'baerum'],
    ['Bærum Bygg', 'baerum-bygg'],
    ['BÆRUM BYGG', 'baerum-bygg'],
    ['Sør-Norge', 'sor-norge'],
    ['Tromsø Kommune', 'tromso-kommune'],
    ['Ødegård', 'odegard'],
    ['Ålesund', 'alesund'],
    ['Þingvellir', 'thingvellir'],
    ['Ðjúpivogur', 'djupivogur'],
    ['Straße', 'strasse'],
    ['José Café', 'jose-cafe'],
  ];

  // NFD is not exotic here: macOS hands out decomposed strings from filenames and pastes,
  // so the same name can arrive in either normalisation and must slug to the same id.
  const NFD = [
    ['A\u030alesund', 'alesund'], // Ålesund, decomposed
    ['O\u0308stfold', 'ostfold'], // Östfold, decomposed
    ['Jose\u0301 Cafe\u0301', 'jose-cafe'],
  ];

  const ASCII = [
    ['Ballestad Studios', 'ballestad-studios'],
    ['Brygga', 'brygga'],
    ['  Acme   Co.  ', 'acme-co'],
    ['Acme | Co', 'acme-co'],
    ['A/B & C', 'a-b-c'],
    ['FJH-NETT', 'fjh-nett'],
  ];

  it.each([...NORDIC, ...NFD])('slugs %s → %s', (name, expected) => {
    expect(TT.slug(name)).toBe(expected);
  });

  it.each(ASCII)('control: %s still slugs to %s', (name, expected) => {
    expect(TT.slug(name)).toBe(expected);
  });

  it('control: keeps its fallback for a name with nothing sluggable in it', () => {
    expect(TT.slug('')).toBe('task');
    expect(TT.slug('!!!')).toBe('task');
    expect(TT.slug('   ')).toBe('task');
  });

  it('takes a caller-chosen fallback, which is how makeClientId can say "not yet"', () => {
    // A client id must be distinguishable-from-nothing rather than invented, so the client
    // path passes ''. That difference is the only reason the two rules were ever separate.
    expect(TT.slug('!!!', '')).toBe('');
    expect(TT.slug('Bærum', '')).toBe('baerum');
  });

  it('caps at 24 characters and never ends on a dash', () => {
    const id = TT.slug('Ballestad Studios International Holding Company');
    expect(id.length).toBeLessThanOrEqual(24);
    expect(id.endsWith('-')).toBe(false);
    // the cap landing exactly on a separator is the case that used to leave the dash
    // ('abcdefghijk-lmnopqrstuv-' is what slice(0, 24) alone returns here)
    expect(TT.slug('abcdefghijk lmnopqrstuv wxyz')).toBe('abcdefghijk-lmnopqrstuv');
  });
});

// ## Verified red-green: 2026-07-26
// SB-088: the same defect one function over. Project codes never went through TT.slug at all
// — `makeCode` in App.tsx uppercased and stripped anything outside [A-Z0-9 ], so "Bærum Bygg"
// became BRUM-BYGG: a silently dropped letter in a code Terje reads in the mirror and types
// into the project editor. Extracting it here is what makes it provable below the browser rung.
describe('TT.projectCode transliterates rather than dropping (SB-088)', () => {
  it.each([
    ['Bærum Bygg', 'BAER-BYGG'],
    ['Ålesund', 'ALESUND'],
    ['Ødegård Drift', 'ODEG-DRIF'],
    ['Tromsø', 'TROMSO'],
    ['Straße Bau', 'STRA-BAU'],
  ])('codes %s → %s', (name, expected) => {
    expect(TT.projectCode(name)).toBe(expected);
  });

  it.each([
    ['Fjellheim Nettbutikk', 'FJEL-NETT'],
    ['Lifelines', 'LIFELINE'],
    ['Ops & maintenance', 'OPS-MAIN'],
    ['  spaced   out  ', 'SPAC-OUT'],
  ])('control: %s still codes to %s', (name, expected) => {
    expect(TT.projectCode(name)).toBe(expected);
  });

  it('control: falls back to PROJ when the name yields no code', () => {
    expect(TT.projectCode('')).toBe('PROJ');
    expect(TT.projectCode('!!!')).toBe('PROJ');
  });

  // ## Verified red-green: 2026-07-26
  // SB-110, folded into the same table: the hyphen was DELETED with every other non-alphanumeric,
  // so "Sør-Norge" collapsed into the single word SORNORGE while "Sør Norge" segmented to
  // SOR-NORG. Same name, different shape of answer, for a reason the user cannot see.
  it.each([
    ['Sør-Norge', 'Sør Norge', 'SOR-NORG'],
    ['Nord-Trøndelag', 'Nord Trøndelag', 'NORD-TRON'],
    ['Vest-Agder', 'Vest Agder', 'VEST-AGDE'],
    ['Ops-maintenance', 'Ops maintenance', 'OPS-MAIN'],
  ])('%s segments exactly like %s → %s', (hyphenated, spaced, expected) => {
    expect(TT.projectCode(hyphenated)).toBe(TT.projectCode(spaced));
    expect(TT.projectCode(hyphenated)).toBe(expected);
  });

  it('a hyphen is a separator even where it produces nothing to separate', () => {
    expect(TT.projectCode('Foo-')).toBe('FOO'); // no trailing dash left behind
    expect(TT.projectCode('-Foo')).toBe('FOO');
    expect(TT.projectCode('Sør--Norge')).toBe('SOR-NORG'); // a run collapses like a run of spaces
    expect(TT.projectCode('A-B-C')).toBe('A-B'); // still only the first two words
    expect(TT.projectCode('-')).toBe('PROJ'); // nothing left ⇒ the fallback, not an empty code
  });

  it('the length cap: a hyphenated name inherits the two-word shape, and nothing longer', () => {
    // The ticket asked for this to be checked rather than assumed. A hyphenated name now takes
    // the same path as its space-separated twin, so 9 (4 + dash + 4) is its maximum — one more
    // than the single-word cap of 8, and exactly what the spaced form already produced.
    expect(TT.projectCode('Nord-Trøndelag')).toHaveLength(9);
    expect(TT.projectCode('Nord Trøndelag')).toHaveLength(9);
    expect(TT.projectCode('Abcdefgh-Ijklmnop-Qrstuv').length).toBeLessThanOrEqual(9);
    expect(TT.projectCode('Abcdefghijklmnop')).toHaveLength(8); // one word is still capped at 8
  });
});

// ## Verified red-green: 2026-07-26
// SB-111: three id-minting sites, two de-collision conventions, and two of them broke their own
// length cap. `derivedClientId` counted `brygga`, `brygga-2`, `brygga-3`; `createProject` and
// `createTask` APPENDED a literal `2`, so a third collision read `code222` — unreadable and
// unbounded. All three grew PAST their cap: `base + '-2'` is 26 against TT.slug's 24, `code + '2'`
// is 10 against a project code's 9.
//
// RULING (2026-07-26): one convention everywhere — a `-2` / `-3` suffix that fits INSIDE the cap,
// with the base truncated to make room rather than the id appended past it. An id is a visible
// join key in the markdown mirror, so its width is a promise to the reader.
describe('TT.uniqueId — one de-collision rule, and the suffix fits inside the cap (SB-111)', () => {
  /** @param {string[]} ids */
  const taken = (ids) => (id) => ids.includes(id);

  it('hands back the base untouched when nothing holds it', () => {
    expect(TT.uniqueId('brygga', taken([]), TT.ID_CAP)).toBe('brygga');
    expect(TT.uniqueId('SOR-NORG', taken(['OTHER']), TT.CODE_CAP)).toBe('SOR-NORG');
  });

  it('counts -2, -3, -4 … and never repeats the old append-a-2 shape', () => {
    expect(TT.uniqueId('brygga', taken(['brygga']), TT.ID_CAP)).toBe('brygga-2');
    expect(TT.uniqueId('brygga', taken(['brygga', 'brygga-2']), TT.ID_CAP)).toBe('brygga-3');
    expect(TT.uniqueId('brygga', taken(['brygga', 'brygga-2', 'brygga-3']), TT.ID_CAP)).toBe('brygga-4');
    // the shapes the two old conventions produced, asserted absent
    expect(TT.uniqueId('brygga', taken(['brygga', 'brygga-2']), TT.ID_CAP)).not.toBe('brygga22');
  });

  it('truncates the BASE to make room, so the finished id never exceeds the cap', () => {
    // This is the whole ruling. `base + '-2'` used to be 26 characters against a cap of 24.
    const base = TT.slug('Ballestad Studios International Holding Company');
    expect(base).toHaveLength(24); // the base is already AT the cap
    const next = TT.uniqueId(base, taken([base]), TT.ID_CAP);
    expect(next).toHaveLength(24);
    expect(next).toBe('ballestad-studios-inte-2');
    expect(next.startsWith(base.slice(0, 22))).toBe(true); // still recognisably the same id
  });

  it('a project code de-collides inside 9, where the old rule made 10', () => {
    const code = TT.projectCode('Sør-Norge'); // SOR-NORG, 8 characters
    const next = TT.uniqueId(code, taken([code]), TT.CODE_CAP);
    expect(next).toBe('SOR-NOR-2');
    expect(next.length).toBeLessThanOrEqual(TT.CODE_CAP);
    expect(next).not.toBe('SOR-NORG2'); // 9 here, but 10 on the next collision and unbounded after
  });

  it('a two-digit suffix still fits — the base gives back one more character', () => {
    const held = ['base'];
    for (let n = 2; n <= 10; n++) held.push(TT.uniqueId('base', taken(held), TT.CODE_CAP));
    expect(held[held.length - 1]).toBe('base-10');
    for (const id of held) expect(id.length).toBeLessThanOrEqual(TT.CODE_CAP);
  });

  it('a truncation that lands on a dash drops it — no id reads `foo--2`', () => {
    expect(TT.uniqueId('abcdefghijklmnopqrstu-vw', taken(['abcdefghijklmnopqrstu-vw']), 24)).toBe('abcdefghijklmnopqrstu-2'); // prettier-ignore
    expect(TT.uniqueId('abcdefghijklmnopqrstu-vw', taken(['abcdefghijklmnopqrstu-vw']), 24)).not.toContain('--');
  });

  it('the property the rule exists for: whatever comes out is free', () => {
    // Every id these sites mint lands in a TEXT PRIMARY KEY; a duplicate is the save-lock SB-067
    // documents, not a cosmetic clash.
    for (const cap of [TT.ID_CAP, TT.CODE_CAP]) {
      const held = ['base'];
      for (let i = 0; i < 12; i++) {
        const next = TT.uniqueId('base', taken(held), cap);
        expect(held).not.toContain(next);
        expect(next.length).toBeLessThanOrEqual(cap);
        held.push(next);
      }
    }
  });
});

// ## Verified red-green: 2026-07-26
// SB-122: the `[[Wikilink]]` rule was composed TWICE, in opposite orders — the daily-note
// `Project` cell bracketed first and escaped the brackets along with the name, the catalog note's
// `Note` column escaped first and bracketed after. Both halves round-tripped, but only because
// `TT.encodeCell` happens not to escape `[`. That is a coincidence of today's cell codec, not a
// property either site asserted, and a wikilink is a JOIN KEY here: the catalog says which note a
// project is written as, the daily block writes that note, and the parser resolves it back to a
// code. A mangled one is `rateOf()` returning 0, not a cosmetic defect.
//
// So the suite below runs every claim TWICE: once under the real `encodeCell`, and once under a
// WIDENED one that also escapes `[` and `]` — the future change this ticket exists to survive.
// A test that only passed under today's escape set would be green for the wrong reason.
describe('the wikilink composition is one rule, independent of encodeCell (SB-122)', () => {
  /** @param {Partial<import('../shared/types.ts').Project>} o */
  const P = (o) => ({ code: 'LT-01', name: 'Lifelines Tycoon', clientId: null, rate: null, billable: true, archived: false, ...o }); // prettier-ignore
  /** @param {Partial<import('../shared/types.ts').VaultEntry>} o */
  const E = (o) => ({ id: 'ephemeral', date: '2026-01-05', start: null, end: null, durMin: 30, project: null, label: '', note: '', billable: false, ...o }); // prettier-ignore
  /** The nth line's cells, trimmed and STILL escaped — `| a | b |` → ['a', 'b']. */
  const cells = (region, line) => TT.splitCells(region.split('\n')[line]).slice(1, -1);

  /**
   * Run `fn` with `TT.encodeCell` widened to escape `[` and `]` as well. `decodeCell` is already
   * unconditional (`\X` → `X` for any X), so widening the write half alone is a faithful
   * simulation of the change — nothing else in the codec needs to move.
   */
  const withBracketsEscaped = (fn) => {
    const real = TT.encodeCell;
    TT.encodeCell = (s) => (s == null ? '' : String(s)).replace(/[\\|[\]]/g, (c) => '\\' + c);
    try {
      expect(TT.encodeCell('a[b')).toBe('a\\[b'); // the premise of this whole block
      return fn();
    } finally {
      TT.encodeCell = real;
    }
  };

  // Note names that carry the characters the two orders disagree about, plus the ones the escape
  // set already covers, so a regression in either half shows up here.
  const NAMES = [
    'Nettbutikk rebuild', // the ordinary case — the control
    'Arkiv | 2025', // the delimiter: an unescaped one splits the row
    'Back\\slash', // the escape character itself
    'Notes [draft] 2026', // a bracket INSIDE the name — the coincidence, stated
    '[[Nested]]', // the whole wikilink syntax as a name
    'Trailing ]', // the name that collides with the closing bracket pair
  ];

  /**
   * The property, stated once: for one note name, the daily block and the catalog note emit the
   * SAME bytes, and both sides read the model back. Byte equality is what a second composition
   * breaks; the two round-trips are what a broken read side breaks.
   */
  const bothSidesAgree = (note) => {
    const projects = [P({ vaultNote: note })];
    const catalog = TT.serializeVaultCatalogSection('projects', projects, { revision: 1 });
    const parsedCatalog = TT.parseVaultCatalogSection(['# Time Turtle', '', catalog, ''].join('\n'), 'projects');
    expect(parsedCatalog.quarantine).toBe(false);
    expect(parsedCatalog.rows[0].vaultNote).toBe(note);

    // the daily block is resolved against the catalog TT just READ BACK, not the one it holds in
    // memory — that is the join this ticket is about
    const opts = { headers: ['Time', 'Project'], projects: parsedCatalog.rows };
    const day = TT.serializeVaultBlock([E({ project: 'LT-01' })], opts);
    const parsedDay = TT.parseVaultBlock(day, { date: '2026-01-05', projects: parsedCatalog.rows });
    expect(parsedDay.quarantine).toBe(false);
    expect(parsedDay.entries[0].project).toBe('LT-01');

    // ONE composition ⇒ one set of bytes. `Note` is the last catalog column, `Project` the second
    // daily one; both rows are line 4 of their region.
    const noteCell = cells(catalog, 4).pop();
    const projectCell = cells(day, 4)[1];
    expect(projectCell).toBe(noteCell);
    return projectCell;
  };

  it.each(NAMES)('%s: the catalog Note cell and the daily Project cell are the same bytes', (note) => {
    bothSidesAgree(note);
  });

  it.each(NAMES)('%s: still the same bytes once encodeCell escapes `[` and `]`', (note) => {
    withBracketsEscaped(() => bothSidesAgree(note));
  });

  it('the widened escape set really does change the bytes — the guard is not a no-op', () => {
    // Without this, both blocks above could be passing on identical output and the second one
    // would prove nothing. A bracket in the NAME is escaped under the wider set and not under the
    // narrow one, while the structural brackets stay literal in both.
    const narrow = bothSidesAgree('Notes [draft] 2026');
    const wide = withBracketsEscaped(() => bothSidesAgree('Notes [draft] 2026'));
    expect(narrow).toBe('[[Notes [draft] 2026]]');
    expect(wide).toBe('[[Notes \\[draft\\] 2026]]');
    expect(wide).not.toBe(narrow);
  });

  it('a wikilink no project claims is still carried verbatim under the wider escape set', () => {
    // The pre-SB-122 read side ran WIKILINK_RE on the DECODED cell. Under the wider set the
    // unclaimed-link fallback is where that difference surfaces: TT must hand back the note text,
    // never the still-escaped bytes.
    withBracketsEscaped(() => {
      const projects = [P({ vaultNote: 'Lifelines Tycoon' })];
      const day = TT.serializeVaultBlock([E({ project: '[[Planning [2026]]]' })], { headers: ['Time', 'Project'] });
      const parsed = TT.parseVaultBlock(day, { date: '2026-01-05', projects });
      expect(parsed.quarantine).toBe(false);
      expect(parsed.entries[0].project).toBe('[[Planning [2026]]]');
    });
  });
});

// ---------------------------------------------------------------------------
// DD-017 §1 — the read-only rule, and the fact that it is the exact complement of
// `TT.vaultBound` rather than a second opinion about the same three conditions.
//
// PLAN-015 / SB-102. `TT.vaultBound` already existed (PLAN-012 landed it) and is the one home of
// shape + cutover + ledger. The three predicates below are DERIVED from the same two clauses, so
// the repo holds exactly one date comparison and exactly one ledger scan. The invariant that
// makes DD-017 a rule rather than a coincidence — under `personal`, editable ⇔ vault-bound — is
// EXECUTED here over the table, not asserted in a comment.
//
// The `team` rows are not padding: `readOnlyDay`'s other branch is the whole of SDD-002 ruling 6
// (the admin exemption), and a table with only `personal` rows would let a broken `team` branch
// through untouched.
describe('the read-only rule (DD-017 §1)', () => {
  // A DAY, not an instant (DD-026 clause 6). It was `'2026-07-15T09:12:33.000Z'` while the value
  // came from a SQLite stamp and `preCutover` sliced it; the Catalog's validator refuses anything
  // but `YYYY-MM-DD` now, so a table built on an instant would be testing a value TT cannot hold.
  const CUTOVER = '2026-07-15';
  const BEFORE = '2026-07-14'; // strictly before the cutover DAY
  const ON = '2026-07-15'; // the cutover day itself is NOT before it
  const AFTER = '2026-07-20'; // Monday, week 30
  const AFTER_KEY = TT.segmentKey(AFTER);
  const COMMITS = [{ key: AFTER_KEY, committedAt: '2026-07-27T00:00:00.000Z' }];

  // Named rows, so a failure prints WHICH row rather than `[object Object]`.
  // expected = [preCutover, frozenSegment, readOnlyDay]
  const row = (shape, cutover, commits, admin, date, expected) => ({
    name: `${shape} / cutover ${cutover || '(never stamped)'} / ${commits.length ? 'ledger' : 'no ledger'} / ${admin ? 'admin' : 'employee'} / ${date}`,
    shape,
    cutover,
    commits,
    admin,
    date,
    expected,
  });
  const ROWS = [
    // personal, cutover stamped, nothing committed
    row('personal', CUTOVER, [], false, BEFORE, [true, false, true]),
    row('personal', CUTOVER, [], false, ON, [false, false, false]),
    row('personal', CUTOVER, [], false, AFTER, [false, false, false]),
    // personal, cutover stamped, the AFTER segment committed — the ledger wins over the date,
    // which is DD-017 §2 and the clause a same-side-of-the-cutover table cannot distinguish
    row('personal', CUTOVER, COMMITS, false, BEFORE, [true, false, true]),
    row('personal', CUTOVER, COMMITS, false, ON, [false, false, false]),
    row('personal', CUTOVER, COMMITS, false, AFTER, [false, true, true]),
    // personal, admin: the flag is READ BY THE TEAM BRANCH ONLY, so it changes nothing here.
    // This is the DD-015-depth-2 hazard in one row — the personal user IS the seeded admin.
    row('personal', CUTOVER, COMMITS, true, BEFORE, [true, false, true]),
    row('personal', CUTOVER, COMMITS, true, AFTER, [false, true, true]),
    // personal, cutover never stamped (''): no history is excluded
    row('personal', '', COMMITS, false, BEFORE, [false, false, false]),
    row('personal', '', COMMITS, false, AFTER, [false, true, true]),
    // team: no cutover clause at all, and the admin exemption (SDD-002 ruling 6) stands
    row('team', CUTOVER, COMMITS, false, BEFORE, [false, false, false]),
    row('team', CUTOVER, COMMITS, false, AFTER, [false, false, true]),
    row('team', CUTOVER, COMMITS, true, AFTER, [false, false, false]),
    row('team', CUTOVER, [], false, AFTER, [false, false, false]),
    // an unknown/absent shape is not `personal`, so it takes the team branch
    row(null, CUTOVER, COMMITS, false, AFTER, [false, false, true]),
  ];

  it.each(ROWS)('$name', ({ shape, cutover, commits, admin, date, expected }) => {
    const ctx = { shape, cutover, commits, admin };
    expect([TT.preCutover(date, ctx), TT.frozenSegment(date, ctx), TT.readOnlyDay(date, ctx)]).toEqual(expected);
  });

  // REWRITTEN, NOT DELETED (DD-026 clause 2, PLAN-017 task 4). This used to assert one thing —
  // "under `personal`, readOnlyDay is the EXACT complement of vaultBound" — and that held only
  // because the Cutover could never be absent: SQLite stamped it the moment the shape was stored.
  // Moving it into a vault file makes absence reachable, and in that one state the two questions
  // genuinely get different answers. So the assertion says what the relation IS now, over BOTH
  // branches, rather than being weakened to cover the branch that changed.
  it('with a readable Cutover the two are still exact complements', () => {
    const withCutover = ROWS.filter((r) => r.shape === 'personal' && r.cutover);
    expect(withCutover.length).toBeGreaterThan(0);
    for (const { shape, cutover, commits, admin, date, name } of withCutover) {
      const ctx = { shape, cutover, commits, admin };
      expect(TT.readOnlyDay(date, ctx), name).toBe(!TT.vaultBound({ date }, ctx));
    }
  });

  it('with NO readable Cutover they diverge, and each is right about its own question', () => {
    // The whole of clause 2 in one assertion. `vaultBound` false everywhere: TT does not know
    // where this vault's history starts, so no day of it is TT's to write. `readOnlyDay` false
    // everywhere the LEDGER does not freeze: the app works against SQLite and reconciles once the
    // Catalog is read. Fail-open and fail-closed are both rejected by name, and this is the row
    // that would go red if either were built.
    const noCutover = ROWS.filter((r) => r.shape === 'personal' && !r.cutover);
    expect(noCutover.length).toBeGreaterThan(0);
    for (const { shape, cutover, commits, admin, date, name } of noCutover) {
      const ctx = { shape, cutover, commits, admin };
      expect(TT.vaultBound({ date }, ctx), name + ' — vaultBound').toBe(false);
      expect(TT.readOnlyDay(date, ctx), name + ' — readOnlyDay').toBe(TT.committedOn(date, commits));
    }
    // and the divergence is REAL rather than an artefact of the rows: a day that is neither
    // committed nor pre-anything is editable AND not vault-bound at the same time
    const open = { shape: 'personal', cutover: '', commits: [], admin: false };
    expect(TT.readOnlyDay(AFTER, open)).toBe(false);
    expect(TT.vaultBound({ date: AFTER }, open)).toBe(false);
  });

  it('a Cutover is a DAY, and the day itself is never before itself (clause 6)', () => {
    // No `.slice(0, 10)` survives in the rule, so an instant handed in by a caller that has not
    // been updated does NOT quietly half-work: `'2026-07-15' < '2026-07-15T09:12:33.000Z'` is
    // true, so the cutover day itself would read as pre-cutover. This is the assertion that
    // catches such a caller.
    const day = { shape: 'personal', cutover: '2026-07-15', commits: [], admin: false };
    expect(TT.preCutover('2026-07-14', day)).toBe(true);
    expect(TT.preCutover('2026-07-15', day)).toBe(false);
    expect(TT.preCutover('2026-07-16', day)).toBe(false);
  });

  it('the ledger is scanned in ONE place — committedOn is shape-blind and the others gate it', () => {
    expect(TT.committedOn(AFTER, COMMITS)).toBe(true);
    expect(TT.committedOn(BEFORE, COMMITS)).toBe(false);
    expect(TT.committedOn(AFTER, [])).toBe(false);
    expect(TT.committedOn(AFTER, undefined)).toBe(false);
    // a null hole in the ledger array is survivable — the server strips segments per-role
    expect(TT.committedOn(AFTER, [null, { key: AFTER_KEY }])).toBe(true);
  });

  it('vaultBound keeps its exact guards: a non-string date and a missing context are false', () => {
    const ctx = { shape: 'personal', cutover: CUTOVER, commits: COMMITS };
    expect(TT.vaultBound(null, ctx)).toBe(false);
    expect(TT.vaultBound({ date: 20260720 }, ctx)).toBe(false);
    expect(TT.vaultBound({ date: AFTER }, undefined)).toBe(false); // no shape → not personal
    expect(TT.preCutover(20260714, ctx)).toBe(false);
    expect(TT.frozenSegment(20260720, ctx)).toBe(false);
    expect(TT.readOnlyDay(20260720, ctx)).toBe(false);
  });
});
