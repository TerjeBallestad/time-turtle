// @ts-check
// Cross-user aggregation for the admin team report (SB-009).
//
// The privacy line: /api/state stays strictly per-user, and this module is the
// only path by which one user's time reaches another's screen — as sums, never
// as rows. Notes, timestamps and entry ids are read here and dropped here.
//
// Billing has to be summed server-side anyway: billMinutes rounds each entry up
// to the client's increment individually, so a total is not recoverable from a
// pre-rounded total.
import TT from '../../shared/core.js';
import * as db from './db.js';

/** @typedef {import('../../shared/types.ts').Catalog} Catalog */
/** @typedef {import('../../shared/types.ts').TeamReportRow} TeamReportRow */

/**
 * Sum every user's entries in an inclusive date range into (person × project) buckets.
 * @param {{ from?: string, to?: string }} [range] omit a bound to leave it open
 * @returns {TeamReportRow[]}
 */
export function teamReport({ from, to } = {}) {
  // The billing helpers take a Catalog; entries stay empty because each entry is
  // costed individually below.
  // SDD-002: entries own their project code, so aggregation reads it directly — no
  // task lookup, and tasks (now per-user templates) are irrelevant to the report.
  /** @type {Catalog} */
  const catalog = {
    settings: db.getSettings(),
    clients: db.getClients(),
    projects: db.getProjects(),
    tasks: [],
    entries: [],
  };
  const names = new Map(db.listUsers().map((user) => [user.id, user.name]));
  // SDD-002 ruling 8: cost a committed entry from its FROZEN snapshot and everything
  // else from the live catalog, via the shared snapshot-preferring readers. The reader
  // reads `catalog.commits`, so swap in the acting user's ledger per entry (cached, and
  // entries arrive grouped by user). A rate renegotiation then moves an uncommitted
  // month but never a committed one.
  /** @type {Map<number, import('../../shared/types.ts').CommitSegment[]>} */
  const commitsByUser = new Map();
  /** @param {number} userId */
  const commitsOf = (userId) => {
    let commits = commitsByUser.get(userId);
    if (!commits) {
      commits = db.getCommits(userId);
      commitsByUser.set(userId, commits);
    }
    return commits;
  };
  /** @type {Map<string, TeamReportRow>} */
  const buckets = new Map();
  for (const { userId, ...entry } of db.getAllEntries(from, to)) {
    const code = TT.entryProjectCode(catalog, entry);
    const key = userId + '\u0000' + (code ?? '');
    let bucket = buckets.get(key);
    if (!bucket) {
      const project = TT.projectOf(catalog, code);
      bucket = {
        userId,
        userName: names.get(userId) ?? '—',
        project: code,
        clientId: project ? project.clientId : null,
        min: 0,
        bill: 0,
        amount: 0,
        entries: 0,
      };
      buckets.set(key, bucket);
    }
    catalog.commits = commitsOf(userId);
    bucket.min += TT.entryMinutes(entry);
    bucket.bill += TT.effectiveBillMinutes(catalog, entry);
    bucket.amount += TT.effectiveAmount(catalog, entry);
    bucket.entries += 1;
  }
  return [...buckets.values()];
}
