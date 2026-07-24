// Unit tests over shared/core.js — pure logic: time parsing, ISO weeks,
// billing rounding, overnight rollover, and the display formatters.
//
// ## Verified red-green: 2026-07-23
// PLAN-007 (SB-025): monthSegments/monthGood/segmentApproved review rollup.
// ## Verified red-green: 2026-07-24
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
