// @ts-check
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { PORT, MD_DIR_LOCKED } from './config.js';
import { backendTarget, activeBackend, backendLocked } from './backend.js';
import { verifyPassword, makeToken, readSessionCookie, sessionCookie, clearCookie } from './auth.js';
// SB-056: the split is at the import site on purpose. `db` is IDENTITY ONLY here — users,
// passwords, token versions, the first-run seed — and every TIMESHEET-STORAGE read/write goes
// through `store`, which is where SB-057's vault implementation lands. If a new `db.` call
// appears below that is not about a user account, it belongs on `store`. See store.js's header.
import * as db from './db.js';
import * as store from './store.js';
// SB-056: `writeMirror` is NOT imported here any more — every mirror write goes through
// `store.mirror`, which is off under `vault` (DD-011). See store.js.
import { mirrorTarget, mirrorPath, mirrorBlockFor, acknowledgeMirrorBlock } from './markdown.js';
import { teamReport } from './reports.js';
import TT from '../../shared/core.js';

/** @typedef {import('express').Request} Request */
/** @typedef {import('express').Response} Response */
/** @typedef {import('express').NextFunction} NextFunction */
/** @typedef {import('../../shared/types.ts').User} User */

db.seedIfEmpty();

const app = express();
app.use(express.json({ limit: '4mb' }));

// ---- auth middleware ----
/** @param {Request} req @param {Response} res @param {NextFunction} next */
function requireUser(req, res, next) {
  const sess = readSessionCookie(req);
  const user = sess ? db.findUserById(sess.userId) : null;
  // SB-013: reject a token whose version is behind the stored one — the cookie was
  // issued before a password change, so its session is no longer trusted.
  if (!sess || !user || sess.tokenVersion !== db.getTokenVersion(user.id)) {
    return res.status(401).json({ error: 'not authenticated' });
  }
  req.user = user;
  next();
}
/** @param {Request} req @param {Response} res @param {NextFunction} next */
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

// ---- auth routes ----
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? db.findUserByEmail(email) : null;
  if (!user || !verifyPassword(password ?? '', user.password_hash)) {
    return res.status(401).json({ error: 'wrong email or password' });
  }
  res.setHeader('Set-Cookie', sessionCookie(makeToken(user.id, user.token_version)));
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});
app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearCookie);
  res.json({ ok: true });
});
app.get('/api/me', requireUser, (req, res) => res.json({ user: req.user }));

// ---- passwords ----
/** @param {unknown} password @returns {string | null} */
function passwordError(password) {
  return typeof password === 'string' && password.length > 0 ? null : 'a non-empty password is required';
}
// Self-service change: proves knowledge of the current password, so a stolen
// session cookie on its own cannot lock the owner out.
app.post('/api/me/password', requireUser, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const invalid = passwordError(newPassword);
  if (invalid) return res.status(400).json({ error: invalid });
  const stored = db.findUserWithHash(req.user.id);
  if (!stored || !verifyPassword(currentPassword ?? '', stored.password_hash)) {
    return res.status(401).json({ error: 'current password is wrong' });
  }
  db.setUserPassword(req.user.id, newPassword);
  // SB-013: the bump above invalidated this caller's own cookie too — hand back a
  // fresh one at the new version so changing your password does not log you out.
  res.setHeader('Set-Cookie', sessionCookie(makeToken(req.user.id, db.getTokenVersion(req.user.id) ?? 0)));
  res.json({ ok: true });
});
// Admin reset — the "forgot it" path. Replaces deleting and recreating the user,
// which CASCADEd their entries away (SB-010).
app.post('/api/users/:id/password', requireUser, requireAdmin, (req, res) => {
  const { password } = req.body || {};
  const invalid = passwordError(password);
  if (invalid) return res.status(400).json({ error: invalid });
  const id = +req.params.id;
  if (!db.findUserById(id)) return res.status(404).json({ error: 'no such user' });
  db.setUserPassword(id, password);
  res.json({ ok: true });
});

// ---- state ----
// Employees never see hourly rates: stripped server-side, not just hidden in the UI.
/** @param {User} user */
function stateFor(user) {
  const admin = user.role === 'admin';
  /** @type {<T extends { rate: number | null }>(row: T) => T} */
  const strip = admin ? (row) => row : (row) => ({ ...row, rate: null });
  // SDD-002 ruling 4/5 (DD-003): an employee has money stripped everywhere. The commit
  // ledger's key + committedAt are kept so their Week-header chips can render which
  // segments are committed, and approvedAt is kept too so a LOCKED (admin-approved)
  // segment's chip can render read-only (ruling 5) — but the per-entry money snapshot is
  // dropped (a server strip, not a UI hide) and releasedBy is admin-internal. Admins keep
  // the full segment.
  const commits = store.getCommits(user.id);
  return {
    user,
    version: store.getVersions(user.id),
    mdDirLocked: MD_DIR_LOCKED,
    // SB-056: the EFFECTIVE backend, not the stored one — the env and the lock can both beat
    // the setting, and every client capability check reads this. Additive and read-only: this
    // pair is the one wire change SB-056 makes, and "backend=sqlite comes out byte-for-byte
    // unchanged" is a claim about the DB and the mirror bytes, not about the envelope.
    backend: activeBackend(),
    backendLocked: backendLocked(),
    // SB-065: a standing mirror refusal is STATE, not a log line — a mirror that has
    // quietly stopped updating still looks current, which is the failure this guards.
    mirrorBlocked: mirrorBlockFor(user),
    settings: store.getSettings(),
    clients: store.getClients().map(strip),
    projects: store.getProjects().map(strip),
    tasks: store.getTasks(user.id),
    entries: store.getEntries(user.id),
    commits: admin
      ? commits
      : commits.map((c) => ({
          key: c.key,
          committedAt: c.committedAt,
          snapshot: {},
          ...(c.approvedAt ? { approvedAt: c.approvedAt } : {}),
        })),
  };
}
app.get('/api/state', requireUser, (req, res) => res.json(stateFor(req.user)));

// The shared collections — one 'catalog' version covers them all. SDD-002 moved
// task templates OUT to per-user state, so they ride the caller's 'entries' scope.
const CATALOG_KEYS = ['settings', 'clients', 'projects'];

/** A stale-write rejection, mapped to 409 by the PUT handler. */
class ConflictError extends Error {
  /** @param {string} scope @param {import('../../shared/types.ts').StateVersion} version */
  constructor(scope, version) {
    super(scope + ' changed since you loaded it');
    this.version = version;
  }
}

/**
 * SB-070: an entry id is the ONE caller-supplied string that reaches the mirror's `## commits`
 * section, and that section is deliberately not escaped (see the commits serializer in
 * shared/core.js — every field in it is machine-generated, so encodeCell would be a no-op).
 * An id holding a `|` therefore splits its own frozen-money row: `  - a|b | 1250 | 60 | 100`
 * parses back to snapshot key `a` with rate NaN, silently rewriting COMMITTED money on a
 * mirror restore. Terje's ruling (option 1) closes it at the source instead of escaping the
 * section: reject the id at the API boundary, loud and explicit, server-side.
 *
 * The charset is what the machine already produces — `nid()` (`e<n>-<base36>`), and any
 * `TT.segmentKey` output — so nothing legitimate is rejected. It deliberately excludes `:`:
 * ISO timestamps live on the commit SEGMENT (`committedAt`/`approvedAt`), never on an entry.
 */
const ENTRY_ID_RE = /^[A-Za-z0-9._-]+$/;
/**
 * The first bad entry id in a collection-replace payload, as an error message, or null when
 * every id is clean. @param {any[]} entries @returns {string | null}
 */
function entryIdError(entries) {
  for (const entry of entries) {
    const id = entry == null || entry.id == null ? '' : String(entry.id);
    if (!ENTRY_ID_RE.test(id))
      return (
        'invalid entry id ' +
        JSON.stringify(id) +
        ': an entry id may contain only letters, digits, dot, underscore and hyphen'
      );
  }
  return null;
}

/**
 * SB-074: the commit SEGMENT KEY is the other caller-supplied string that reaches the mirror's
 * unescaped `## commits` section — and unlike an entry id (machine-minted by `nid()`) it is taken
 * verbatim from the request body. A key holding a `|` splits its own segment HEADER:
 * `- 2026-W30-2026-07|x | <ts>` parses back as key `2026-W30-2026-07` with committedAt `x`, so two
 * segments now share one key and `TT.commitSnapshot` (`commits.find(...)`, shared/core.js) takes
 * the first — the empty one. Committed money silently vanishes on a mirror restore. Same class as
 * SB-070, same fix shape: reject at the API boundary, before anything writes.
 *
 * DERIVED, NOT RE-DECLARED. `TT.segmentKey` stays the one home of the grammar: a key is valid iff
 * some REAL calendar date actually produces it. The `\d{4}-\d{2}` scan is only a candidate-month
 * generator (every `TT.segmentKey` output ends in the date's `YYYY-MM`); the verdict is always the
 * `TT.segmentKey(date) === key` comparison against live output. So this cannot silently drift if
 * the grammar changes — it would start over-rejecting LOUDLY, and the "accepts real segment keys"
 * test is the alarm. Being an exact-output check it also rejects well-formed-but-nonsense keys
 * (`2026-W99-2026-07`, or a week that never touches the month it names).
 * @param {unknown} key @returns {boolean}
 */
function isSegmentKey(key) {
  // The length cap is a bound on the candidate scan below (a hostile 10KB key would otherwise
  // cost thousands of probes). It is NOT a claim about the grammar — real keys are ~16 chars.
  if (typeof key !== 'string' || !key || key.length > 64) return false;
  for (const match of key.matchAll(/\d{4}-\d{2}/g)) {
    const month = match[0];
    for (let day = 1; day <= 31; day++) {
      const date = month + '-' + String(day).padStart(2, '0');
      if (TT.dateStr(TT.parseDate(date)) !== date) continue; // not a real day of that month
      if (TT.segmentKey(date) === key) return true;
    }
  }
  return false;
}

/**
 * SB-074: `committedAt` rides the same header, emitted raw and POSITIONALLY
 * (`'- ' + seg.key + ' | ' + seg.committedAt`), so a `|` in it forges extra header columns —
 * and the columns after it are the labeled `approved:` / `released:` lock tokens.
 *
 * HONESTY NOTE (measured, see SB-074): this is defence in depth, not a live hole.
 * `reconcileCommits` never trusts a client `committedAt` — a new key is server-stamped and a
 * known key keeps the STORED segment verbatim — so today nothing hostile in this field can reach
 * the store. The guard exists so a future refactor that starts honouring the body cannot quietly
 * re-open the header split.
 *
 * Derived from the emitter, not hand-written: both the server (`new Date().toISOString()`) and the
 * client (`commitSegment` in App.tsx) emit a canonical ISO instant, and a value is accepted iff it
 * survives that exact round-trip. Deliberately NOT SB-070's `[A-Za-z0-9._-]` charset — an ISO
 * timestamp contains `:`, so reusing it would reject every legitimate commit. An ABSENT
 * committedAt is fine (the client may PUT a bare `{ key }`); the server stamps it.
 * @param {unknown} value @returns {boolean}
 */
function isIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/**
 * SB-074: the first structurally invalid thing in an incoming commit ledger, as an error message,
 * or null when it is clean. Three checks, all rejection (SB-070/SB-072 precedent: rejection lives
 * at the API boundary because it can return an error; silent normalization lives in db.js).
 *
 * The duplicate check is the third: two segments sharing one key is nonsense however it arose, and
 * a duplicate is what `TT.commitSnapshot`'s first-match-wins actually chokes on. HONESTY NOTE
 * (measured): like committedAt this is defence in depth — `reconcileCommits` already dedupes
 * incoming keys first-seen-wins, so a duplicate cannot reach the store today either. The
 * duplicates that lose money are the ones MANUFACTURED downstream by a split header, which is what
 * the key check above prevents. Rejecting here makes the invariant explicit instead of implicit in
 * a dedupe loop.
 * @param {any[]} commits @returns {string | null}
 */
function commitLedgerError(commits) {
  const seen = new Set();
  for (const segment of commits) {
    const key = segment == null ? undefined : segment.key;
    if (!isSegmentKey(key))
      return (
        'invalid commit segment key ' +
        JSON.stringify(key === undefined ? null : key) +
        ': a segment key must be one TT.segmentKey produces, e.g. "2026-W30-2026-07"'
      );
    if (seen.has(key))
      return 'duplicate commit segment key ' + JSON.stringify(key) + ': a segment may appear only once';
    seen.add(key);
    const at = segment.committedAt;
    if (at != null && !isIsoInstant(at))
      return (
        'invalid committedAt ' +
        JSON.stringify(at) +
        ' on segment ' +
        JSON.stringify(key) +
        ': committedAt must be an ISO timestamp'
      );
  }
  return null;
}

/**
 * SDD-002 ruling 7 (PLAN-006): the never-referenced true-delete guard, mapped to 409.
 * Archive is the default path; a HARD delete is a code/id ABSENT from the collection-
 * replace PUT (there is no DELETE route). The server allows a hard delete only when the
 * dropped code/id is never referenced — otherwise old history would orphan — so a PUT
 * that drops a still-referenced project code or client id is rejected and the row survives.
 */
class ReferencedDeleteError extends Error {}

/**
 * SDD-002 ruling 7: reject a PUT that hard-deletes (drops from the collection-replace) a
 * project code any user's entry references, or a client id any project references. Archived
 * rows are NOT deletes (they are present-with-archived=true) so they never trip this. Runs
 * inside the write transaction so the reference check and the write cannot be split.
 * @param {{ clients?: any[], projects?: any[] }} body
 */
function guardReferencedDeletes(body) {
  if (body.projects !== undefined) {
    const incoming = new Set(body.projects.map((project) => String(project.code)));
    for (const stored of store.getProjects()) {
      if (!incoming.has(stored.code) && store.projectCodeReferenced(stored.code))
        throw new ReferencedDeleteError(
          'cannot delete project ' + stored.code + ': it has logged entries (archive it)',
        );
    }
  }
  if (body.clients !== undefined) {
    const incoming = new Set(body.clients.map((client) => String(client.id)));
    for (const stored of store.getClients()) {
      if (!incoming.has(stored.id) && store.clientReferenced(stored.id))
        throw new ReferencedDeleteError('cannot delete client ' + stored.id + ': it has projects (archive it)');
    }
  }
}

/**
 * Employee branch of the SDD-002 derive-vs-freeze rule. billable is admin-owned and
 * now derived from the entry's PROJECT (not a task). An employee's collection-replace
 * PUT re-sends every entry on each debounce, so we cannot 403 it — instead we pin
 * each entry's billable in place: a known entry stays frozen at its stored value
 * (except the one late derivation when a projectless entry first gets a project), and
 * a freshly logged entry derives from its project's default. Templates carry no
 * billable, and projects are admin-only (403'd for employees), so nothing else needs
 * touching. The client derives at the same birth points; this is the enforcement copy.
 * @param {number} userId @param {{ entries?: any[] }} body
 */
function normalizeBillable(userId, body) {
  if (body.entries === undefined) return;
  const projState = { projects: store.getProjects() };
  /** @param {string | null} code */
  const derive = (code) => TT.projectBillable(projState, code ?? null);
  const stored = new Map(store.getEntries(userId).map((entry) => [entry.id, entry]));
  body.entries = body.entries.map((entry) => {
    const prior = stored.get(entry.id);
    if (prior) {
      // Known entry: frozen at its stored value — UNLESS it had no project and is
      // now given one, the one late derivation the rule allows.
      if (prior.project == null && entry.project != null) return { ...entry, billable: derive(entry.project) };
      return { ...entry, billable: prior.billable };
    }
    // Unknown id: a freshly logged hour — derive from its project's default.
    return { ...entry, billable: derive(entry.project ?? null) };
  });
}

/**
 * SDD-002 ruling 6 (SB-025): editedByAdmin is server-authoritative — it is set ONLY by the
 * admin cross-user edit path (PUT /api/users/:id/entries). The SELF path must never let a
 * caller set it, so pin it to the stored value for a known entry and false for a fresh one.
 * Runs for every caller (admin included) on /api/state — the marker is meaningless there.
 * @param {number} userId @param {{ entries?: any[] }} body
 */
function pinEditedByAdmin(userId, body) {
  if (body.entries === undefined) return;
  const stored = new Map(store.getEntries(userId).map((entry) => [entry.id, entry]));
  body.entries = body.entries.map((entry) => {
    const prior = stored.get(entry.id);
    return { ...entry, editedByAdmin: !!(prior && prior.editedByAdmin) };
  });
}

/**
 * SDD-002 ruling 8: the money frozen onto every entry in a segment at commit — the
 * resolved rate, billed minutes and amount, computed from the LIVE catalog. Server-
 * derived and server-owned: an employee has rates stripped and literally cannot
 * produce this, and an admin's client-sent snapshot is never trusted (see reconcile).
 * @param {import('../../shared/types.ts').Catalog} catalog @param {any[]} entries @param {string} key
 */
function deriveSnapshot(catalog, entries, key) {
  /** @type {Record<string, { rate: number, billMin: number, amount: number }>} */
  const snapshot = {};
  for (const entry of entries) {
    if (TT.segmentKey(entry.date) !== key) continue;
    snapshot[entry.id] = {
      rate: TT.rateOf(catalog, TT.entryProjectCode(catalog, entry)),
      billMin: TT.billMinutes(catalog, entry),
      amount: TT.amount(catalog, entry),
    };
  }
  return snapshot;
}

/**
 * SDD-002 ruling 3/4: reconcile the incoming commit keys against what is stored.
 *   • a key present in BOTH  → keep the stored committedAt + snapshot VERBATIM
 *     (committed money is frozen; never recompute on a later rate change),
 *   • a NEW key              → server-stamp committedAt + derive the snapshot from the
 *     live catalog over this user's entries in the segment (the client-sent snapshot,
 *     which an employee cannot even compute, is discarded),
 *   • a REMOVED key          → dropped (un-commit; the snapshot is discarded).
 * Rewrites `body.commits` to the reconciled ledger, and returns the set of segment
 * keys that were committed before AND remain committed after — the read-only set an
 * employee's entries are pinned against next (reconcile FIRST, ruling 5). When the PUT
 * does not carry `commits`, the ledger is untouched and every stored segment stays
 * committed. The money snapshot is derived from the entries as they will be written
 * (`body.entries` post-normalize), so a same-PUT edit-then-commit freezes the new value.
 *
 * SDD-002 ruling 5: for an EMPLOYEE caller, a stored APPROVED-and-not-released segment is
 * force-kept even when the incoming ledger omits its key — the employee's free un-commit is
 * gone until an admin Release. Admins are never force-kept here (they reconcile a target
 * via the dedicated edit/approve endpoints, and never self-lock).
 * @param {number} userId @param {any} body @param {boolean} isEmployee
 * @returns {{ pinnedKeys: Set<string> }}
 */
function reconcileCommits(userId, body, isEmployee) {
  const stored = store.getCommits(userId);
  const storedByKey = new Map(stored.map((commit) => [commit.key, commit]));
  // Keys the employee cannot drop: approved-and-not-released (the ruling-5 lock).
  const lockedKeys = isEmployee ? stored.filter((commit) => TT.segmentApproved(commit)).map((c) => c.key) : [];
  if (body.commits === undefined) return { pinnedKeys: new Set(storedByKey.keys()) };
  // Dedupe incoming keys, preserving first-seen order.
  /** @type {string[]} */
  const incomingKeys = [];
  const seen = new Set();
  for (const commit of body.commits) {
    if (commit && typeof commit.key === 'string' && !seen.has(commit.key)) {
      seen.add(commit.key);
      incomingKeys.push(commit.key);
    }
  }
  // Force-keep any locked segment the employee's PUT tried to drop — it stays committed
  // (and, being in incomingKeys now, stays in the read-only pinned set below).
  for (const key of lockedKeys) {
    if (!seen.has(key)) {
      seen.add(key);
      incomingKeys.push(key);
    }
  }
  const effectiveEntries = body.entries !== undefined ? body.entries : store.getEntries(userId);
  /** @type {import('../../shared/types.ts').Catalog} */
  const catalog = {
    settings: store.getSettings(),
    clients: store.getClients(),
    projects: store.getProjects(),
    tasks: [],
    entries: [],
  };
  body.commits = incomingKeys.map((key) => {
    const prior = storedByKey.get(key);
    if (prior) return prior; // frozen — verbatim
    return { key, committedAt: new Date().toISOString(), snapshot: deriveSnapshot(catalog, effectiveEntries, key) };
  });
  const reconciledKeys = new Set(incomingKeys);
  return { pinnedKeys: new Set([...storedByKey.keys()].filter((key) => reconciledKeys.has(key))) };
}

/**
 * SDD-002 ruling 5 (DD-003): committed segments are READ-ONLY for the employee. On a
 * collection-replace PUT, force every stored entry in a pinned segment back to its
 * stored value: an EDIT is reverted, a moved entry is kept at its stored date, an ADD
 * into a pinned segment is dropped, and a DELETE of a committed entry is re-inserted.
 * Everything outside the pinned segments passes through untouched — so un-committing a
 * segment (it leaves `pinnedKeys`) and editing its entries in the same PUT is allowed.
 * Admins are EXEMPT (ruling 6); this is only ever called for employees.
 * @param {number} userId @param {any} body @param {Set<string>} pinnedKeys
 */
function pinCommittedEntries(userId, body, pinnedKeys) {
  if (body.entries === undefined || pinnedKeys.size === 0) return;
  const stored = store.getEntries(userId);
  const storedById = new Map(stored.map((entry) => [entry.id, entry]));
  /** @param {string} date */
  const isPinned = (date) => pinnedKeys.has(TT.segmentKey(date));
  const result = [];
  const usedIds = new Set();
  // 1. every stored entry in a pinned segment is forced back, unchanged.
  for (const entry of stored) {
    if (isPinned(entry.date)) {
      result.push(entry);
      usedIds.add(entry.id);
    }
  }
  // 2. walk the submission; a pinned stored entry is already forced (ignore its
  //    submitted version); an add/move INTO a pinned segment is rejected (revert to the
  //    stored value if we have one, else drop); everything else passes through.
  for (const entry of body.entries) {
    if (usedIds.has(entry.id)) continue;
    if (isPinned(entry.date)) {
      const prior = storedById.get(entry.id);
      if (prior) {
        result.push(prior);
        usedIds.add(prior.id);
      }
      continue;
    }
    result.push(entry);
    usedIds.add(entry.id);
  }
  body.entries = result;
}

// Collection-replace writes. Role rules:
//   admin    → clients, projects, settings, tasks (own), entries (own)
//   employee → tasks (own), entries (own) — clients/projects/settings rejected
// SDD-002: tasks are per-user templates, so they are the caller's own collection
// (never cross-user) and ride the per-user 'entries' version scope, not 'catalog'.
// DC-001: a `version` in the body makes the write conditional — if the scope it
// touches has moved on, nothing is written and the client gets a 409. Without it
// the write is unconditional, as before.
app.put('/api/state', requireUser, (req, res) => {
  const body = req.body || {};
  const admin = req.user.role === 'admin';
  const adminOnly = ['clients', 'projects', 'settings'].filter((key) => body[key] !== undefined);
  if (!admin && adminOnly.length) {
    return res.status(403).json({ error: 'employees cannot edit: ' + adminOnly.join(', ') });
  }
  for (const key of ['clients', 'projects', 'tasks', 'entries', 'commits']) {
    if (body[key] !== undefined && !Array.isArray(body[key]))
      return res.status(400).json({ error: key + ' must be an array' });
  }
  // SB-070: charset-check every entry id BEFORE any of the normalize/pin/reconcile helpers
  // touch the body, so a rejected PUT writes nothing at all.
  if (body.entries !== undefined) {
    const badId = entryIdError(body.entries);
    if (badId) return res.status(400).json({ error: badId });
  }
  // SB-074: same deal for the commit ledger — shape-check every segment key against what
  // TT.segmentKey actually produces, check committedAt is an ISO instant, and refuse a repeated
  // key. Runs BEFORE reconcileCommits (and every other helper) so a rejected PUT writes nothing.
  if (body.commits !== undefined) {
    const badCommit = commitLedgerError(body.commits);
    if (badCommit) return res.status(400).json({ error: badCommit });
  }
  // DC-002: with TT_MD_DIR_LOCK set the mirror path is env-only. Compare against the
  // stored value rather than rejecting the key outright — the client PUTs the whole
  // settings object, so an unchanged mdDir rides along with every currency/language edit.
  if (
    MD_DIR_LOCKED &&
    body.settings &&
    body.settings.mdDir !== undefined &&
    String(body.settings.mdDir) !== store.getSettings().mdDir
  ) {
    return res.status(403).json({ error: 'mirror folder is locked by server configuration (TT_MD_DIR_LOCK)' });
  }
  // SB-056, DC-002 again: with TT_BACKEND_LOCK set the backend is env-only. Compare against
  // the STORED value rather than rejecting the key — the client PUTs the whole settings object
  // on every currency edit, and a blanket 403 would wedge it: `useServerSync` re-queues any
  // non-409 failure and retries every 4 s forever, so an unchanged value has to ride along.
  if (
    backendLocked() &&
    body.settings &&
    body.settings.backend !== undefined &&
    String(body.settings.backend) !== store.getSettings().backend
  ) {
    return res.status(403).json({ error: 'storage backend is locked by server configuration (TT_BACKEND_LOCK)' });
  }
  const expected = body.version;
  if (expected !== undefined && (typeof expected !== 'object' || expected === null)) {
    return res.status(400).json({ error: 'version must be an object' });
  }
  // SDD-002 / DD-003: billable is admin-owned and derived from the project. An
  // employee's collection-replace PUT re-sends every entry on every debounce, so we
  // cannot 403 it — we pin each entry's billable in place and let the rest through.
  // Admin PUTs are accepted verbatim.
  if (!admin) normalizeBillable(req.user.id, body);
  // editedByAdmin is only ever set by the admin cross-user edit path — the self path pins it
  // to the stored value so no caller can forge the 'edited by admin' marker on their own row.
  pinEditedByAdmin(req.user.id, body);
  // SDD-002 ruling 3/4/5: the server owns the commit ledger. Reconcile the incoming
  // keys against what is stored (deriving/freezing the money snapshot, never trusting a
  // client one) FIRST, then — for an employee only (admins are exempt, ruling 6) — pin
  // every entry in a still-committed segment back to its stored value. Reconcile must
  // precede the pin so a same-PUT un-commit-then-edit is allowed. Runs for every PUT,
  // even one without `commits`, because existing committed segments stay read-only.
  const { pinnedKeys } = reconcileCommits(req.user.id, body, !admin);
  if (!admin) pinCommittedEntries(req.user.id, body, pinnedKeys);
  const touchesCatalog = CATALOG_KEYS.some((key) => body[key] !== undefined);
  // The caller's own per-user data — entries, their templates AND their commit ledger
  // share one scope, so a commit write follows the same DC-001 409 semantics.
  const touchesPersonal = body.entries !== undefined || body.tasks !== undefined || body.commits !== undefined;
  try {
    store.transaction(() => {
      // Checked inside the transaction so the compare and the write cannot be
      // split by another writer.
      const current = store.getVersions(req.user.id);
      if (touchesCatalog && expected?.catalog !== undefined && +expected.catalog !== current.catalog)
        throw new ConflictError('catalog', current);
      if (touchesPersonal && expected?.entries !== undefined && +expected.entries !== current.entries)
        throw new ConflictError('entries', current);
      // SDD-002 ruling 7: refuse to hard-delete a still-referenced code/id (archive instead).
      guardReferencedDeletes(body);
      if (body.settings) store.putSettings(body.settings);
      if (body.clients) store.putClients(body.clients);
      if (body.projects) store.putProjects(body.projects);
      if (body.tasks) store.putTasks(req.user.id, body.tasks);
      if (body.entries) store.putEntries(req.user.id, body.entries);
      if (body.commits !== undefined) store.putCommits(req.user.id, body.commits);
      if (touchesCatalog) store.bumpCatalogVersion();
      if (touchesPersonal) store.bumpEntriesVersion(req.user.id);
    });
  } catch (err) {
    if (err instanceof ConflictError)
      return res.status(409).json({ error: err.message, conflict: true, version: err.version });
    if (err instanceof ReferencedDeleteError) return res.status(409).json({ error: err.message, conflict: true });
    return res.status(400).json({ error: 'save failed: ' + /** @type {Error} */ (err).message });
  }
  /** @type {string | null} */
  let mirror = null;
  /** @type {string | null} */
  let mirrorError = null;
  try {
    mirror = store.mirror(req.user);
  } catch (err) {
    mirrorError = /** @type {Error} */ (err).message;
    console.error('[time-turtle] markdown mirror failed:', mirrorError);
  }
  // SB-065: the DB write above already committed. A guard refusal is reported, never
  // promoted to a 500 — "you cannot save at all" is a worse failure than a stale mirror.
  res.json({
    ok: true,
    version: store.getVersions(req.user.id),
    mirror,
    mirrorError,
    mirrorBlocked: mirrorBlockFor(req.user),
  });
});

// ---- markdown mirror (SB-065) ----
// The acknowledgement seam for the never-clobber guard: "yes, I dealt with it — overwrite
// on the next save". Clearing is all it does; nothing is written here, so acknowledging by
// mistake still costs nothing until the user saves again. Admins may clear another user's
// block, because an admin cross-user edit can be the write that trips it and the target may
// never log in to clear it themselves.
app.post('/api/mirror/acknowledge', requireUser, (req, res) => {
  const requested = req.body && req.body.userId !== undefined ? +req.body.userId : req.user.id;
  if (requested !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const target = requested === req.user.id ? req.user : db.findUserById(requested);
  if (!target) return res.status(404).json({ error: 'no such user' });
  const path = mirrorPath(target);
  const cleared = acknowledgeMirrorBlock(path);
  res.json({ ok: true, cleared, path });
});

// ---- team reports (admin) ----
// Deliberately not folded into /api/state: that stays per-user, and shipping every
// user's raw entries to the client to pivot them there would leak notes and
// timestamps for a view that only ever renders sums.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
app.get('/api/reports/team', requireUser, requireAdmin, (req, res) => {
  const { from, to } = req.query;
  /** @param {unknown} value */
  const badDate = (value) => value !== undefined && (typeof value !== 'string' || !DATE_RE.test(value));
  if (badDate(from) || badDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD dates' });
  const range = { from: /** @type {string | undefined} */ (from), to: /** @type {string | undefined} */ (to) };
  res.json({ from: range.from ?? null, to: range.to ?? null, rows: teamReport(range) });
});

// ---- admin review & cross-user edit (SDD-002 rulings 6 & 5, SB-025) ----
// The deliberate SB-009 crossing: dedicated ADMIN-ONLY, target-id-scoped endpoints (not a
// mode of /api/state) so requireAdmin gates the whole surface. An employee is 403'd by the
// requireAdmin middleware before any read or write. Money is PRESENT for the admin (they
// already see rates); it never leaks to the target — their own /api/state stays stripped.

/** The entry fields an admin edit can change (editedByAdmin is the marker, not a field). */
const ENTRY_FIELDS = ['date', 'start', 'end', 'durMin', 'project', 'label', 'note', 'billable'];
/** @param {any} a @param {any} b @returns {boolean} */
function entryDiffers(a, b) {
  return ENTRY_FIELDS.some((field) => (a[field] ?? null) !== (b[field] ?? null));
}

// Read any user's full timesheet — their entries, commit ledger (money present) and task
// templates, plus the shared catalog so the review view can render project labels/colours
// and compute live money for uncommitted segments via the snapshot-preferring readers.
app.get('/api/users/:id/timesheet', requireUser, requireAdmin, (req, res) => {
  const id = +req.params.id;
  const target = db.findUserById(id);
  if (!target) return res.status(404).json({ error: 'no such user' });
  res.json({
    user: target,
    settings: store.getSettings(),
    clients: store.getClients(),
    projects: store.getProjects(),
    tasks: store.getTasks(id),
    entries: store.getEntries(id),
    commits: store.getCommits(id), // money PRESENT — admin
    version: store.getVersions(id),
  });
});

// Correct any user's entries line by line (ruling 6). Collection-replace, admin EXEMPT
// from the read-only pin. A changed (or admin-added) line is marked editedByAdmin; a
// committed segment whose entries changed is RE-FROZEN from the corrected entries (the
// authorized corrector updates the frozen truth — ruling 8 stays consistent) while every
// untouched committed segment keeps its frozen money verbatim.
app.put('/api/users/:id/entries', requireUser, requireAdmin, (req, res) => {
  const id = +req.params.id;
  const target = db.findUserById(id);
  if (!target) return res.status(404).json({ error: 'no such user' });
  const body = req.body || {};
  if (!Array.isArray(body.entries)) return res.status(400).json({ error: 'entries must be an array' });
  for (const entry of body.entries) {
    if (!entry || typeof entry.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date)))
      return res.status(400).json({ error: 'each entry needs an id and a YYYY-MM-DD date' });
  }
  // SB-070: the same charset guard as the self path — this route re-freezes commit snapshots
  // too, so a piped id corrupts the target's frozen money exactly the same way.
  const badId = entryIdError(body.entries);
  if (badId) return res.status(400).json({ error: badId });
  // DC-001 optimistic concurrency (mirrors the self path's optional-version shape): a
  // `version` (StateVersion, the entries scope) makes the write conditional — if the
  // target's entries moved since the Review tab loaded (the employee logged an hour, or a
  // second admin saved), nothing is written and the caller gets a 409 with the fresh
  // version. Without a version the write stays unconditional (backward-compat).
  const expected = body.version;
  if (expected !== undefined && (typeof expected !== 'object' || expected === null)) {
    return res.status(400).json({ error: 'version must be an object' });
  }

  const stored = store.getEntries(id);
  const storedById = new Map(stored.map((entry) => [entry.id, entry]));
  // Mark the lines the admin actually changed (or added); an unchanged line keeps its
  // prior marker, so a re-save never clears an earlier admin correction.
  const marked = /** @type {any[]} */ (body.entries).map((entry) => {
    const prior = storedById.get(entry.id);
    if (!prior) return { ...entry, editedByAdmin: true };
    if (entryDiffers(prior, entry)) return { ...entry, editedByAdmin: true };
    return { ...entry, editedByAdmin: !!(prior.editedByAdmin || entry.editedByAdmin) };
  });

  // Which segments did the edit touch? A moved/removed line touches its OLD segment, a
  // moved/added/changed line touches its NEW segment. Only these get re-frozen; every
  // other committed segment stays verbatim (ruling 8 — a later rate change never moves it).
  const incomingById = new Map(marked.map((/** @type {any} */ entry) => [entry.id, entry]));
  const affected = new Set();
  // The lines the edit actually changed (or added). Only these re-derive fresh money; an
  // untouched line inside a touched segment keeps its prior frozen row VERBATIM (ruling 8 —
  // a later rate change never re-prices a line the admin did not correct).
  const changedIds = new Set();
  for (const prior of stored) {
    const next = incomingById.get(prior.id);
    if (!next) {
      affected.add(TT.segmentKey(prior.date));
    } else if (entryDiffers(prior, next)) {
      affected.add(TT.segmentKey(prior.date));
      affected.add(TT.segmentKey(next.date));
      changedIds.add(prior.id);
    }
  }
  for (const next of marked)
    if (!storedById.has(next.id)) {
      affected.add(TT.segmentKey(next.date));
      changedIds.add(next.id); // an added line has no prior frozen row — derive fresh
    }

  /** @type {import('../../shared/types.ts').Catalog} */
  const catalog = {
    settings: store.getSettings(),
    clients: store.getClients(),
    projects: store.getProjects(),
    tasks: [],
    entries: [],
  };
  const commits = store.getCommits(id);
  let commitsChanged = false;
  const reFrozen = commits.map((seg) => {
    if (!affected.has(seg.key)) return seg; // untouched committed segment — frozen verbatim
    commitsChanged = true;
    // Partial re-freeze: derive a fresh money row ONLY for the lines the admin changed or
    // added; every OTHER line in this segment keeps its prior frozen row byte-for-byte, so
    // a rate change since commit never silently re-prices an untouched line (ruling 8).
    // Preserves approvedAt/releasedBy (the …seg spread carries the lock stamps).
    const prior = seg.snapshot || {};
    /** @type {Record<string, any>} */
    const snapshot = {};
    for (const entry of marked) {
      if (TT.segmentKey(entry.date) !== seg.key) continue;
      snapshot[entry.id] =
        !changedIds.has(entry.id) && Object.prototype.hasOwnProperty.call(prior, entry.id)
          ? prior[entry.id] // untouched line — keep its frozen money verbatim
          : deriveSnapshot(catalog, [entry], seg.key)[entry.id]; // changed/added — re-derive at the live rate
    }
    return { ...seg, snapshot };
  });

  try {
    store.transaction(() => {
      // DC-001: compare-and-write inside the transaction so a concurrent writer cannot
      // split the check from the save. A version-less PUT skips the guard (unconditional).
      if (expected?.entries !== undefined) {
        const current = store.getVersions(id);
        if (+expected.entries !== current.entries) throw new ConflictError('entries', current);
      }
      store.putEntries(id, marked);
      if (commitsChanged) store.putCommits(id, reFrozen);
      store.bumpEntriesVersion(id);
    });
  } catch (err) {
    if (err instanceof ConflictError)
      return res.status(409).json({ error: err.message, conflict: true, version: err.version });
    return res.status(400).json({ error: 'save failed: ' + /** @type {Error} */ (err).message });
  }
  /** @type {string | null} */
  let mirror = null;
  /** @type {string | null} */
  let mirrorError = null;
  try {
    mirror = store.mirror(target); // the correction lands in the TARGET's mirror
  } catch (err) {
    mirrorError = /** @type {Error} */ (err).message;
    console.error('[time-turtle] markdown mirror failed:', mirrorError);
  }
  res.json({ ok: true, version: store.getVersions(id), mirror, mirrorError, mirrorBlocked: mirrorBlockFor(target) });
});

// SDD-002 ruling 5 (SB-025): the lock verbs. Approve stamps approvedAt (and clears any
// prior releasedBy) so the employee can no longer un-commit the segment; Release records
// releasedBy and clears approvedAt, handing it back for edits. Both mutate the TARGET's
// ledger, bump the target's version and rewrite their mirror. Admin-only.
/**
 * @param {'approve' | 'release'} verb
 * @returns {import('express').RequestHandler}
 */
function segmentLockHandler(verb) {
  return (req, res) => {
    const id = +req.params.id;
    const key = req.params.key;
    const target = db.findUserById(id);
    if (!target) return res.status(404).json({ error: 'no such user' });
    const commits = store.getCommits(id);
    if (!commits.some((seg) => seg.key === key)) return res.status(404).json({ error: 'no such committed segment' });
    const next = commits.map((seg) => {
      if (seg.key !== key) return seg;
      if (verb === 'approve') {
        const { releasedBy: _drop, ...rest } = seg;
        return { ...rest, approvedAt: new Date().toISOString() };
      }
      const { approvedAt: _drop, ...rest } = seg;
      return { ...rest, releasedBy: req.user.id };
    });
    try {
      store.transaction(() => {
        store.putCommits(id, next);
        store.bumpEntriesVersion(id);
      });
    } catch (err) {
      return res.status(400).json({ error: 'save failed: ' + /** @type {Error} */ (err).message });
    }
    /** @type {string | null} */
    let mirrorError = null;
    try {
      store.mirror(target);
    } catch (err) {
      mirrorError = /** @type {Error} */ (err).message;
      console.error('[time-turtle] markdown mirror failed:', mirrorError);
    }
    res.json({ ok: true, version: store.getVersions(id), mirrorError, mirrorBlocked: mirrorBlockFor(target) });
  };
}
app.post('/api/users/:id/segments/:key/approve', requireUser, requireAdmin, segmentLockHandler('approve'));
app.post('/api/users/:id/segments/:key/release', requireUser, requireAdmin, segmentLockHandler('release'));

// SDD-002 DC-005 (PLAN-006): the server-reconciled project-code rename. A dedicated
// admin-only endpoint rewrites every user's entries + templates old→new in ONE transaction
// (store.renameProjectCode), so a code rename no longer orphans another user's logged history.
// A BLIND reconcile: it never returns another user's entry CONTENT — so SB-009's per-user
// privacy line stays intact. Replaces the old client-only renameProject.
//
// SB-086: it used to return a bare { ok } and swallow every mirror failure into a
// console.error. Before SB-065 that was merely untidy; now each failure records a STICKY
// mirrorBlocked for that user, so the rename answered a clean success while one or more
// users' mirrors had silently entered the blocked state — and a blocked mirror still LOOKS
// current on disk, which is the exact failure the guard exists to make visible. The other
// three store.mirror call sites all surface mirrorBlocked on their response; this one was the
// odd path out. It reports now, in a LIST rather than the singular the others carry, because
// this is the one route that writes SEVERAL users' mirrors in a single request. (The client
// rename below writes exactly one — a pure catalog change — so it keeps the singular shape.)
// A path is not entry content: the acting caller is an admin, who can already list users and
// knows the mirror folder, and the name in the filename is one they can read from /api/users.
app.post('/api/projects/:code/rename', requireUser, requireAdmin, (req, res) => {
  const from = String(req.params.code);
  const to = req.body && typeof req.body.to === 'string' ? req.body.to.trim() : '';
  if (!to) return res.status(400).json({ error: 'a non-empty target code is required' });
  const projects = store.getProjects();
  if (!projects.some((p) => p.code === from)) return res.status(404).json({ error: 'no such project' });
  if (from !== to && projects.some((p) => p.code === to))
    return res.status(409).json({ error: 'a project with that code already exists' });
  /** @type {number[]} */
  let affected;
  try {
    affected = store.renameProjectCode(from, to);
  } catch (err) {
    return res.status(400).json({ error: 'rename failed: ' + /** @type {Error} */ (err).message });
  }
  // Rewrite each affected user's mirror (their entries/templates moved) plus the acting
  // admin's, so the markdown reflects the new code. Other stale mirrors refresh on their
  // next write, matching the codebase's existing eventual-consistency stance.
  //
  // SB-086: every failure is COLLECTED, not swallowed. One rename can block several users at
  // once, so the loop keeps going — a refusal on user A's mirror must not cost user B theirs —
  // and the report comes back as two parallel lists. `mirrorErrors` carries every failure
  // including ones that are not guard refusals (permissions, a full disk); `mirrorBlocks`
  // carries only the sticky blocks, which are the ones somebody has to acknowledge. Like the
  // other three call sites, a mirror refusal never fails the request: the rename transaction
  // has already committed, and turning a refused mirror into a 500 would leave the caller
  // believing a rename that DID happen did not.
  /** @type {import('../../shared/types.ts').MirrorBlock[]} */
  const mirrorBlocks = [];
  /** @type {string[]} */
  const mirrorErrors = [];
  for (const id of new Set([...affected, req.user.id])) {
    const user = db.findUserById(id);
    if (!user) continue;
    try {
      store.mirror(user);
    } catch (err) {
      const message = /** @type {Error} */ (err).message;
      mirrorErrors.push(message);
      console.error('[time-turtle] markdown mirror failed:', message);
      // Read the STANDING block rather than err.block: it is the same state /api/state
      // reports and the same state POST /api/mirror/acknowledge clears, so the caller is
      // never told about a block that a later acknowledgement has already cleared.
      const block = mirrorBlockFor(user);
      if (block) mirrorBlocks.push(block);
    }
  }
  res.json({ ok: true, mirrorBlocks, mirrorErrors });
});

/**
 * SB-087 (SB-067 fix 3): the client-id charset, at the API boundary.
 *
 * DERIVED FROM THE MINTER, not invented here: this is exactly what `makeClientId`
 * (client/src/clientIds.ts) produces — lowercase ASCII, digits, single dashes between
 * segments, no leading/trailing dash, capped at 24. The UI normalizes through that same
 * function before it calls, so nothing the app can produce is rejected; this is the
 * reject-before-anything-writes backstop for everything else (SB-070 / SB-074 precedent).
 *
 * It matters because a client id is a `|`-delimited CELL in the mirror's `## clients`
 * section AND the join key in every `## projects` row — the id is the readable identifier
 * Terje reads in the markdown, so a `|`, a newline or a stray space in it is a corrupt
 * catalog rather than an ugly one.
 *
 * Only the TARGET is validated. Ids already stored (`client7`, a hand-seeded one) are
 * grandfathered — a rename is how you get OUT of a legacy id, so validating the source
 * would lock the door from the inside.
 */
const CLIENT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLIENT_ID_MAX = 24;

// SB-087 (SB-067 fix 3): the server-reconciled CLIENT-ID rename.
//
// WHY AN ENDPOINT AND NOT A FATTER PUT. `guardReferencedDeletes` reads the STORED rows
// before the write, so a single collection-replace that swaps the id AND re-points the
// projects still 409s `cannot delete client <id>: it has projects` — the old id is absent
// from the incoming clients while the stored projects still reference it. The drop and the
// re-point can only meet inside one transaction, which is what `store.renameClientId` is.
// (Pinned by the SB-067 test in tests/api.test.js, which asserts that exact 409.)
//
// MUCH SMALLER THAN THE PROJECT RENAME. `Project.clientId` is the only persisted reference
// to a client id anywhere, so this is one `UPDATE projects SET client_id` and NO user's
// entries or templates move. Which is also why only the ACTING admin's mirror is rewritten
// here, unlike the project rename above: a client rename is a pure CATALOG change, and the
// codebase already refreshes catalog changes into the actor's mirror only (`PUT /api/state`),
// every other user's on their next write. Nothing per-user moved, so nobody else's mirror is
// newly wrong in a way it was not already. That single mirror is why this response carries
// the singular `mirrorBlocked` the other one-mirror routes carry, rather than SB-086's list.
app.post('/api/clients/:id/rename', requireUser, requireAdmin, (req, res) => {
  const from = String(req.params.id);
  const to = req.body && typeof req.body.to === 'string' ? req.body.to.trim() : '';
  if (!to) return res.status(400).json({ error: 'a non-empty target id is required' });
  if (to.length > CLIENT_ID_MAX || !CLIENT_ID_RE.test(to))
    return res.status(400).json({
      error:
        'invalid client id ' +
        JSON.stringify(to) +
        ': a client id may contain only lowercase letters, digits and single dashes, and is at most ' +
        CLIENT_ID_MAX +
        ' characters',
    });
  const clients = store.getClients();
  if (!clients.some((client) => client.id === from)) return res.status(404).json({ error: 'no such client' });
  // A READABLE uniqueness error. Without this the PK backstop surfaces as
  // `400 save failed: … UNIQUE constraint failed: clients.id` — accurate and useless.
  if (from !== to && clients.some((client) => client.id === to))
    return res.status(409).json({ error: 'client id ' + to + ' is already in use' });
  /** @type {number} */
  let projects;
  try {
    projects = store.renameClientId(from, to);
  } catch (err) {
    return res.status(400).json({ error: 'rename failed: ' + /** @type {Error} */ (err).message });
  }
  /** @type {string | null} */
  let mirror = null;
  /** @type {string | null} */
  let mirrorError = null;
  try {
    mirror = store.mirror(req.user);
  } catch (err) {
    mirrorError = /** @type {Error} */ (err).message;
    console.error('[time-turtle] markdown mirror failed:', mirrorError);
  }
  // The re-pointed count is catalog data the caller can already GET; it is the one number
  // that says whether this was a bare id swap or a reconcile, so it is worth returning.
  res.json({ ok: true, projects, mirror, mirrorError, mirrorBlocked: mirrorBlockFor(req.user) });
});

// ---- user management (admin) ----
app.get('/api/users', requireUser, requireAdmin, (req, res) => res.json({ users: db.listUsers() }));
app.post('/api/users', requireUser, requireAdmin, (req, res) => {
  const { email, name, role, password } = req.body || {};
  if (!email || !name || !password) return res.status(400).json({ error: 'email, name and password are required' });
  if (db.findUserByEmail(email)) return res.status(409).json({ error: 'a user with that email already exists' });
  res.json({ user: db.createUser({ email, name, role, password }) });
});
app.delete('/api/users/:id', requireUser, requireAdmin, (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: 'cannot delete the account you are logged in as' });
  db.deleteUser(id);
  res.json({ ok: true });
});

// ---- static client (production build, if present) ----
const clientDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(join(clientDist, 'index.html')));
}

// The banner must name the directory mirrors actually land in — mirrorTarget(), not the
// env path — and say which source won, so a wrong-looking mirror is diagnosable from the
// first line of the log instead of from four stale files (SB-073).
const MIRROR_SOURCE = {
  'env-locked': 'TT_MD_DIR, frozen by TT_MD_DIR_LOCK',
  setting: 'mdDir setting',
  env: 'TT_MD_DIR',
  default: 'default',
};
// SB-056: same lesson, same shape, for the backend. Which source won is the whole point —
// "TT_BACKEND=vault but the stored setting says sqlite" is otherwise invisible until someone
// runs a census.
const BACKEND_SOURCE = {
  'env-locked': 'TT_BACKEND, frozen by TT_BACKEND_LOCK',
  setting: 'backend setting',
  env: 'TT_BACKEND',
  default: 'default',
};

app.listen(PORT, () => {
  const backend = backendTarget();
  const target = mirrorTarget();
  console.log(
    `[time-turtle] api on http://localhost:${PORT}  ·  storage backend: ${backend.backend}  (${BACKEND_SOURCE[backend.source]})`,
  );
  if (backend.shadowed)
    console.log(
      `[time-turtle] the stored backend setting overrides TT_BACKEND=${backend.shadowed} — that backend is not in use`,
    );
  // SB-056 design decision 3: `vault` is selectable BEFORE SB-057 fills the vault store in,
  // because SB-056's own required evidence needs it selectable and DD-011's retirement is
  // present tense. The cost is real and is said out loud here rather than discovered.
  if (backend.backend === 'vault')
    console.log(
      '[time-turtle] vault backend: the markdown mirror is off (DD-011), committing is off until phase 3 (DD-008), markdown paste-back is off, and nothing yet syncs the SQLite index from vault files (SB-057)',
    );
  console.log(
    `[time-turtle] markdown mirror → ${target.dir}  (${MIRROR_SOURCE[target.source]})${backend.backend === 'vault' ? '  — not written under the vault backend' : ''}`,
  );
  if (target.shadowed)
    console.log(
      `[time-turtle] the stored mdDir setting overrides TT_MD_DIR ${target.shadowed} — nothing is written there`,
    );
});
