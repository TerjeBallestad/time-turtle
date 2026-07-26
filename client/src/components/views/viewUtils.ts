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
// SB-102: `isCommitted(state, date)` USED TO LIVE HERE and is gone rather than wrapped. It was a
// second answer to "is this day frozen" — the one question that must not exist twice — its only
// caller was TimeGrid's lock expression, and that expression is now `TT.readOnlyDay`, which gates
// `TT.committedOn` (shared/core.js). A wrapper with no callers is just the second copy waiting
// for someone to reach for it, which is the failure `TT.vaultBound`'s own header warns about.
//
// `committedKeys` above and `isApproved` below both stay, and both still touch the ledger: one
// builds a key SET for the Week chips, the other asks whether a segment was APPROVED. Different
// questions, so they are deliberately not routed through `committedOn` — the rule being kept to
// one home is the read-only rule, not every mention of `state.commits`.
// SDD-002 ruling 5 (SB-025): which segments an admin has APPROVED (locked). The employee's
// ledger carries approvedAt through the server strip, so these are all the Week chip and
// the locked grid need to render an approved segment as read-only-and-un-reopenable.
export function approvedKeys(state: Catalog): Set<string> {
  return new Set((state.commits ?? []).filter((commit) => commit.approvedAt).map((commit) => commit.key));
}
export function isApproved(state: Catalog, date: string): boolean {
  return (state.commits ?? []).some((commit) => commit.key === TT.segmentKey(date) && !!commit.approvedAt);
}
