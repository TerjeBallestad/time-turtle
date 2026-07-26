// Small entry helpers shared by the views (and Settings). These are data selectors,
// not styles — the style constants that used to live alongside them in viewStyles.ts
// have moved into views.module.css and the per-view modules.
import TT from '../../i18n';
import type { Catalog, Entry } from '../../../../shared/types';

export function entriesOn(state: Catalog, date: string): Entry[] {
  return state.entries.filter((entry) => entry.date === date);
}
export function sumMin(entries: Entry[]): number {
  return entries.reduce((sum, entry) => sum + TT.entryMinutes(entry), 0);
}

// SDD-002 ruling 4: which (ISO week ∩ month) segments the caller has committed. The
// employee's ledger carries key + committedAt (money snapshot stripped), which is all
// the chips and the read-only lock need.
export function committedKeys(state: Catalog): Set<string> {
  return new Set((state.commits ?? []).map((commit) => commit.key));
}
// SB-102: a THIN WRAPPER, not a second opinion. "Derive the day's segment key and walk the
// ledger" is written exactly once, in `TT.committedOn` (shared/core.js), which `TT.frozenSegment`
// and `TT.readOnlyDay` also gate. This keeps the (state, date) call shape the views already use.
export function isCommitted(state: Catalog, date: string): boolean {
  return TT.committedOn(date, state.commits);
}
// SDD-002 ruling 5 (SB-025): which segments an admin has APPROVED (locked). The employee's
// ledger carries approvedAt through the server strip, so these are all the Week chip and
// the locked grid need to render an approved segment as read-only-and-un-reopenable.
export function approvedKeys(state: Catalog): Set<string> {
  return new Set((state.commits ?? []).filter((commit) => commit.approvedAt).map((commit) => commit.key));
}
export function isApproved(state: Catalog, date: string): boolean {
  return (state.commits ?? []).some((commit) => commit.key === TT.segmentKey(date) && !!commit.approvedAt);
}
