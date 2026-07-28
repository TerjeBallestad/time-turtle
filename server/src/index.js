// @ts-check
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { PORT, HOST, MD_DIR_LOCKED, isLoopbackHost, isLoopbackHostHeader, isLoopbackPeer } from './config.js';
import { shapeTarget, activeShape, shapeLocked } from './backend.js';
import { verifyPassword, makeToken, readSessionCookie, sessionCookie, clearCookie } from './auth.js';
// SB-056: the split is at the import site on purpose. `db` is IDENTITY ONLY here — users,
// passwords, token versions, the first-run seed — and every TIMESHEET-STORAGE read/write goes
// through `store`, which is where SB-057's vault implementation lands. If a new `db.` call
// appears below that is not about a user account, it belongs on `store`. See store.js's header.
import * as db from './db.js';
import * as store from './store.js';
// SB-056: `writeMirror` is NOT imported here any more — every mirror write goes through
// `store.mirror`, which is off under `vault` (DD-011). See store.js.
import { mirrorTarget, mirrorPath, mirrorBlockFor, acknowledgeMirrorBlock, retireMirrors } from './markdown.js';
// PLAN-013 / DD-018: the shape-switch preflight. Its own module because the boot banner below
// needs the same numbers with no HTTP in the room — see shape-preflight.js's header.
import { shapePreflight, strandingBannerLines } from './shape-preflight.js';
// SB-057: the sync engine. Imported here and nowhere else in the API layer — the routes have no
// business knowing the vault is being watched, and the only thing this file does with it is start
// it once the server is answering.
import { startVaultSync, scanVault, vaultSyncConfig, forgetOwnWrites, setVaultRewriter } from './vault-sync.js';
import { rewriteVaultDate, setVaultCheckpointHook } from './vault-write.js';
import { vaultCheckpoint } from './vault-checkpoint.js';

// SB-057: the two arbitration verdicts that need a WRITE are handed back to the writer HERE, at
// the one place that already imports both. The engine never imports the writer, so the dependency
// runs one way: store → vault-write → vault-sync → db.
setVaultRewriter((date, rev) => {
  const config = vaultSyncConfig();
  if (config) rewriteVaultDate(config.userId, date, rev);
});

// SB-068: and the same trick for the checkpoint. The writer owns the WHEN (its first write of a
// calendar day, which is the only place that moment exists — `tt serve` runs detached for weeks,
// so a per-boot hook would mean a per-fortnight checkpoint); this module owns the WHAT.
//
// Wired at module load and not inside `app.listen`, because the trigger is a write and not a
// boot: a save arriving during the boot scan must find the hook already in place. Resolving the
// config PER CALL rather than closing over one is what makes the checkpoint follow the vault when
// Settings → Vault re-points it — the same reason the rewriter above does.
setVaultCheckpointHook((day) => {
  const config = vaultSyncConfig();
  if (config) vaultCheckpoint(config.root, day);
});
import { teamReport } from './reports.js';
import TT from '../../shared/core.js';

/** @typedef {import('express').Request} Request */
/** @typedef {import('express').Response} Response */
/** @typedef {import('express').NextFunction} NextFunction */
/** @typedef {import('../../shared/types.ts').User} User */

// ---- SB-056 / DD-006 consequence 1: the single-user guard ----
//
// A vault belongs to ONE person. There is no sane answer to whose `Calendar/Daily/2026-07-26.md`
// two employees' entries land in, so this is ruled out by construction rather than deferred to
// a merge story nobody wants to write. It is also what makes the seam line in store.js correct:
// identity stays in SQLite under both shapes precisely BECAUSE the vault holds one user.
//
// THREE DIRECTIONS, and the third is the one the ticket does not spell out:
//   1. `POST /api/users` under `personal`             → 403 (in the user-management routes)
//   2. switching TO `personal` with >1 user stored    → 403 (in PUT /api/state)
//   3. BOOTING with an effective `personal` shape against a data dir that already holds
//      several users → the server refuses to start (before app.listen).
//
// Direction 3 exists because no runtime guard can fire there: nobody wrote anything, the
// combination simply arrived — a copied data dir, a restored backup, `TT_SHAPE=personal` typed
// on the wrong machine. Two alternatives were considered and rejected. Falling back to `team`
// would restart the mirror INTO the vault, re-creating the two-representations hazard DD-011
// just closed. A refused-writes read-only mode is more surface, and the recovery still needs a
// shell. Refusing to start is the loudest available reading of DD-006's "loud and explicit",
// and it is the only one that cannot be mistaken for working.
//
// It is a SHAPE claim, not a role claim — under `personal` there is exactly one user and they
// are an admin — so its evidence uses an admin session and that is the right evidence here,
// not a shortcut around the role-evidence rule.

/** The ONLY string that beats a stored `personal` setting. It belongs verbatim in every refusal. */
const SHAPE_RECOVERY = 'TT_SHAPE_LOCK=1 TT_SHAPE=team';
const SECOND_USER_REFUSAL =
  'a vault belongs to one person, so the personal shape allows exactly one user (DD-006): there is no answer to whose daily note a second person’s hours would land in. Switch to the team shape to add users.';
/** @param {number} count how many users are already stored */
const shapeSwitchRefusal = (count) =>
  `cannot switch to the personal shape: a vault belongs to one person and this install has ${count} users (DD-006). Delete the others first, or stay on the team shape.`;
/**
 * DD-024 Amendment 1 §3: storing `personal` on a process bound to a non-loopback address.
 *
 * The boot guard's own recovery line, because it is the same recovery — but it cannot be the boot
 * guard, which fires only when the shape is ALREADY `personal` at module load. Under DD-024 the
 * common path is the other one.
 */
const BIND_REFUSAL =
  'cannot store the personal shape on this process: it is bound to a non-loopback address, and the personal shape has no login (DD-015), so it would serve an unauthenticated timesheet to that network — or, once it refuses every non-loopback peer, to nobody at all. Recover with:  unset TT_HOST';
/**
 * EVERY REASON A SHAPE MAY NOT BE STORED, worded once — a shape-transition door is a second door
 * into one decision, never a second decision. Three doors call this: `POST /api/first-run`,
 * `POST /api/shape` and `PUT /api/state`. A door that refuses less than its siblings is a bypass,
 * and three inlined copies of a growing list is how one comes to refuse less.
 *
 * ORDER MATTERS and is the order the existing doors already applied: the lock first (DC-002, it is
 * env-only and beats any write), then DD-006's one-person rule, then the bind.
 *
 * THE BIND REFUSAL IS THE NEW ONE (DD-024 Amendment 1 §3) and its predicate is exact. `BIND_HOST`
 * `undefined` — the ordinary install with no `TT_HOST` — must NOT refuse, or every first run
 * breaks: an unset `TT_HOST` binds every interface, loopback among them, and DD-024 clause 4's
 * per-request peer refusal is sufficient there. What it catches is `TT_HOST` SET to a routable
 * address: loopback is then never bound at all, so after the answer the process serves NOBODY from
 * ANYWHERE for the life of the process. That is worse than a refusal and it is silent.
 *
 * `isLoopbackHost` is reused rather than joined by a fourth predicate — it reads an
 * operator-supplied value, which is exactly what `BIND_HOST` is.
 * @param {string} shape the shape the caller wants stored @returns {string | null} the refusal, or null
 */
function shapeStoreRefusal(shape) {
  if (shapeLocked()) return 'the instance shape is locked by server configuration (TT_SHAPE_LOCK)';
  // DD-006 consequence 1, direction 2. Compared against the EFFECTIVE shape rather than the stored
  // one, because that is the shape the caller is actually moving away from.
  if (shape === 'personal' && activeShape() !== 'personal') {
    const users = db.listUsers().length;
    if (users > 1) return shapeSwitchRefusal(users);
  }
  if (shape === 'personal' && BIND_HOST != null && !isLoopbackHost(BIND_HOST)) return BIND_REFUSAL;
  return null;
}

/** Is the effective shape one that permits only a single user? @returns {boolean} */
function singleUserShape() {
  return activeShape() === 'personal';
}

/**
 * SB-098 item 4: DD-015's OPEN STATE — the one install configuration where the shape question
 * has two real answers and nobody has given one, so the app asks (`AppState.shapeOpen`).
 *
 * All three conditions, and each rules out a different install that must NOT be asked:
 *   `source === 'default'` — nothing stored, no TT_SHAPE, no TT_SHAPE_LOCK. An install that
 *      answered by env or by lock has answered; re-asking would let a modal overwrite what
 *      its operator typed on the command line. This one condition also subsumes the lock,
 *      which is why there is no separate `shapeLocked()` term.
 *   exactly one user — more than one has ANSWERED BY EXISTING (DD-015), and the boot rule
 *      above stamps those `team` silently. The count is re-checked HERE, per request, because
 *      the boot rule runs once: an open-state install that adds a second user mid-session
 *      leaves the open state the moment it does, without waiting for a restart.
 *   the caller is an admin — "ask at first admin login". Under the open state the single user
 *      IS the admin, so this never fires today; it is here so that the modal can never appear
 *      to an employee if some later path opens the state on a multi-user box.
 *
 * Resolved SERVER-SIDE, like every other shape decision. The client renders the question; it
 * does not get to decide whether it is being asked.
 * @param {User} user @returns {boolean}
 */
function shapeQuestionOpen(user) {
  return shapeTarget().source === 'default' && db.listUsers().length === 1 && user.role === 'admin';
}

// ---- SB-098 / DD-015: the loopback bind, and it is NOT best-effort ----
//
// The personal shape serves a person's timesheet with NO AUTHENTICATION (item 1 below, in
// requireUser). Two things make that acceptable and both are load-bearing; this is the second.
// Bound to 0.0.0.0, "no login" means no login for anyone on the same wifi — every colleague on
// the office network reads and WRITES the vault owner's hours by typing an IP.
//
// So a non-loopback TT_HOST under `personal` REFUSES TO START rather than being ignored or
// quietly overridden. The alternatives were considered and are both worse. Ignoring it leaves
// an operator believing the box is reachable when it is not — annoying but safe — while
// HONOURING it is the catastrophe, and "clamp it to loopback and log a line" is the same
// silent-divergence failure this whole map exists to kill, on the one setting where being
// wrong is unrecoverable: bytes served to the wrong network cannot be recalled.
//
// IT IS THE FIRST THING THAT RUNS, ahead even of `seedIfEmpty` — further ahead than the
// ordering rule below strictly demands, because it can be: it needs the shape and the env and
// nothing else. A boot refused here has not created an admin user, not seeded demo data, not
// stamped a shape or a cutover and not swept a mirror. The one refusal whose subject is "the
// wrong people can read this" should leave the least behind.
//
// It is a shape decision resolved SERVER-SIDE (shapeTarget: env, lock, stored row) — nothing a
// client sends reaches it, and there is no request in flight when it runs.
if (singleUserShape() && HOST && !isLoopbackHost(HOST)) {
  console.error(
    `[time-turtle] refusing to start: the personal shape has no login (DD-015), so it may only bind loopback — but TT_HOST=${JSON.stringify(HOST)} is not a loopback address.`,
  );
  console.error('[time-turtle] serving an unauthenticated timesheet on a reachable interface hands it to the network.');
  console.error(`[time-turtle] recover with:  unset TT_HOST   (or run the team shape:  ${SHAPE_RECOVERY})`);
  process.exit(1);
}
/**
 * The address `app.listen` binds. Under `personal` it is loopback, always — the refusal above
 * has already rejected every TT_HOST that is not, so an explicit loopback TT_HOST is honoured
 * (`::1`, say) and an absent one means `127.0.0.1`. Under `team` an absent TT_HOST keeps the
 * historical every-interface bind exactly as it was.
 */
const BIND_HOST = singleUserShape() ? HOST || '127.0.0.1' : HOST || undefined;

db.seedIfEmpty();

// SB-056 / DD-006 consequence 1, direction 3: the boot refusal. See the single-user guard's
// comment block above for why refusing to start is the right shape and what was rejected.
//
// IT RUNS BEFORE THE SWEEP, and the order is load-bearing. A process whose contract is "I
// refuse to start" must not mutate the vault on its way out: with the sweep first, a copied
// data dir booted into `personal` renamed every mirror file it could find and THEN exited 1
// telling the operator to recover — leaving a spurious `.retired-<date>.md` behind from a boot
// that never happened. Rename-only means no bytes were lost, but the file they were looking at
// had moved for no reason.
{
  const users = db.listUsers().length;
  if (singleUserShape() && users > 1) {
    console.error(
      `[time-turtle] refusing to start: the personal shape allows exactly one user (DD-006) and this data dir holds ${users}.`,
    );
    console.error(`[time-turtle] recover with:  ${SHAPE_RECOVERY}`);
    console.error('[time-turtle] that combination beats the stored shape setting, which TT_SHAPE on its own does not.');
    process.exit(1);
  }
}

// ---- SB-100: what the boot answers for itself ----
//
// BOTH WRITES BELOW SIT AFTER THE REFUSAL, and that is the same load-bearing ordering the
// retirement sweep has: a process whose contract is "I refuse to start" must not mutate the
// data dir on its way out. A refused boot writes neither a shape nor a cutover.
{
  const target = shapeTarget();
  // DD-015, the inference rule: more than one user has ANSWERED THE QUESTION BY EXISTING.
  // Stamp `team`, silently, never ask — every deployed team install sails past this with no
  // modal, and SB-098's first-run question never has to render a refusal it cannot resolve.
  //
  // Keyed on `source === 'default'`, NOT on the user count alone. `env`, `env-locked` and
  // `setting` are all installs that have already answered, and re-answering one underneath its
  // operator would turn the loud direction-3 boot refusal into silence — someone who types
  // TT_SHAPE=personal at a five-user data dir must still be refused, not quietly overruled.
  //
  // `default` + one user is the OPEN state, and it deliberately stays open: SB-098 ships the
  // asking, and a row written here would answer the question before anyone was asked.
  if (target.source === 'default' && db.listUsers().length > 1) {
    store.putSettings({ shape: 'team' });
    console.log(
      `[time-turtle] inferred shape: team — this data dir holds ${db.listUsers().length} users, which answers it (DD-015)`,
    );
  }
  // DD-016, the cutover: the instant this install became `personal`. Stamped for the EFFECTIVE
  // shape rather than only for a stored one, because `TT_SHAPE=personal` reaches the same live
  // vault without ever writing a setting — and an unstamped vault store has no pre-cutover
  // history at all, i.e. every entry eligible, which is DD-016's hazard inverted.
  //
  // It stamps the DATE, not the shape: the row written here must never turn an env choice into
  // a stored one, or TT_SHAPE would stop being how you change your mind.
  //
  // Idempotent and first-stamp-wins. ENFORCING it — no vault write, no DD-012 adoption for
  // entries dated before it — is SB-057's, because that is where a vault write first exists.
  if (target.shape === 'personal') {
    const at = store.stampVaultCutover();
    console.log(`[time-turtle] vault cutover: ${at} — entries dated before it stay in SQLite (DD-016)`);

    // ---- PLAN-013 / SB-115 / DD-018: what this boot just STRANDED ----
    //
    // DD-018 keeps the env path UNGATED on purpose — you cannot ask a boot, and an env var is the
    // operator's answer — but it owes the same sentences the modal owes, because an env-switched
    // install is precisely the one where nobody was in the room at the moment of stranding.
    //
    // PLACEMENT IS THE WHOLE THING, and it is why this is HERE and not in the `app.listen`
    // callback: after the stamp, so the preflight reads the cutover now in force; before
    // `retireMirrors()` below, so the mirror files are still there to count and so SB-115's
    // ordering rule — ENTRIES FIRST, FILES LAST — is true where the per-file retirement lines
    // already print. The listen banner is deliberately untouched: DD-018's mock is abbreviated and
    // the composite `api on … · shape: … · storage: …` line is SB-073's.
    //
    // The SENTENCES are composed in shape-preflight.js, next to the numbers they describe; the
    // EMISSION is here, one `console.log` per line, because the order rule is a claim about
    // separate statements. An empty list is the silence rule and prints nothing.
    //
    // `db.listUsers()[0]` is safe HERE and would not be higher up: `seedIfEmpty()` guarantees a
    // row and the single-user refusal has already run, so under `personal` there is exactly one.
    //
    // WRAPPED, for the same reason `retireMirrors` guards its `saveGuard` (server/src/markdown.js):
    // this is a bare top-level call, so an unguarded throw would kill the server at import with a
    // stack trace — and this whole block exists to print a log line. A boot that cannot say what it
    // stranded still boots.
    try {
      for (const line of strandingBannerLines(db.listUsers()[0].id)) console.log('[time-turtle]   ' + line);
    } catch (err) {
      console.error(`[time-turtle] could not report what this boot stranded: ${/** @type {Error} */ (err).message}`);
    }
  }
}

// SB-056 / DD-011: the one-shot boot sweep. NOT optional and not redundant with the sweep
// store.mirror does on every save — an install switched by `TT_SHAPE=personal` alone never
// fires a settings write, so without this the mirror files would sit next to the daily notes
// looking current until somebody happened to save. Idempotent; runs after seedIfEmpty so
// listUsers() is populated on a first run, and after the refusal above so a server that is
// not going to start touches nothing.
if (!TT.shapeCapabilities(activeShape()).mirror) {
  // PLAN-013: the total. `retireMirrors()` has always returned what it renamed and this call site
  // has always discarded it. It belongs HERE and nowhere else — `retireMirrors` also runs on every
  // save via `store.mirror`, so a total printed inside it would fire on every keystroke.
  const retired = retireMirrors();
  if (retired.length)
    console.log(`[time-turtle] ${retired.length} mirror file${retired.length === 1 ? '' : 's'} retired in total`);
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// ---- auth middleware ----
/**
 * SB-098 / DD-015 depth 2, item 1: the implicit local session.
 *
 * Under `personal` there is exactly ONE human and the machine is theirs, so the cookie
 * challenge asks a question with one possible answer. `requireUser` resolves that answer
 * itself and the Login screen is never rendered. The user RECORD is untouched — `user_id 1`,
 * the schema, and every `user_id` join stay exactly as they are (depth 3, dropping `user_id`,
 * was rejected: it would make the two shapes two programs).
 *
 * THIS IS THE ONE PLACE AUTHENTICATION CAN BE SKIPPED, and it stays the one place. Two
 * properties are what make that safe, and neither is negotiable:
 *
 *   1. IT KEYS OFF THE EFFECTIVE SHAPE, resolved server-side by `shapeTarget()` from the env,
 *      the lock and the stored row. Nothing the client sends reaches this decision. A
 *      client-supplied shape hint here would not be a design smell, it would be a one-line
 *      auth bypass: any request could claim `personal` and skip the challenge. There is
 *      deliberately no header, no query parameter and no body field consulted below.
 *   2. IT IS LOOPBACK-ONLY. The boot block above refuses to start `personal` on a
 *      non-loopback bind, so "no login" cannot silently mean "no login for the whole office".
 *   3. SB-136: IT IS ADDRESSED-TO-LOOPBACK-ONLY. Property 2 covers the wifi; it does not cover
 *      a web page the user merely visited, because DNS REBINDING DEFEATS LOOPBACK — an
 *      attacker domain re-resolving to 127.0.0.1 is same-origin to the browser, so there is no
 *      preflight to fail and no opaque response to hide behind, and with no cookie to be
 *      missing the whole API is readable AND writable by that page. The `Host` header is the
 *      one thing the page cannot forge, so a Host that is not loopback is refused below.
 *
 * The COUNT CHECK is belt and braces rather than the guarantee: three separate guards already
 * make >1 user under `personal` unreachable (the boot refusal, the `POST /api/users` refusal
 * and the switch refusal), but if one of them were ever weakened, the failure mode without
 * this line is picking an arbitrary person's timesheet for an anonymous caller. With it, the
 * shape simply falls back to asking who you are, which is the safe direction.
 *
 * A REAL COOKIE STILL WINS where there is one — a session that survives a `team → personal`
 * switch keeps working rather than being silently re-pointed.
 * @param {Request} req @param {Response} res @param {NextFunction} next
 */
function requireUser(req, res, next) {
  const sess = readSessionCookie(req);
  const user = sess ? db.findUserById(sess.userId) : null;
  // SB-013: reject a token whose version is behind the stored one — the cookie was
  // issued before a password change, so its session is no longer trusted.
  if (!sess || !user || sess.tokenVersion !== db.getTokenVersion(user.id)) {
    if (!TT.shapeCapabilities(activeShape()).identity) {
      // SB-136, property 3. It sits INSIDE the no-identity branch and nowhere else: under
      // `team` this block is never entered, so the demo instance's cookie challenge is
      // untouched — and even here a REAL COOKIE STILL WINS, because a request carrying one
      // never reaches this branch at all. 403, not 401: nothing about the caller's credentials
      // would make this request acceptable.
      //
      // The refusal says nothing back about the Host it was sent — reflecting an
      // attacker-chosen string into a response body is a habit worth not having.
      if (!isLoopbackHostHeader(req.headers.host)) {
        return res.status(403).json({ error: 'this request was not addressed to localhost' });
      }
      const only = db.listUsers();
      // `findUserById`, not the list row, so `req.user` is byte-identical to what the cookie
      // path produces — one session object, one shape, whichever way it was resolved.
      const local = only.length === 1 ? db.findUserById(only[0].id) : null;
      if (local) {
        req.user = local;
        return next();
      }
    }
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
/**
 * SB-057: the daily notes TT has stopped writing to. Derived from `vault_index`, so it is sticky
 * across restarts by construction and needs no ledger of its own.
 *
 * The REASON CODE is carried raw and the wording is resolved on the surface
 * (`TT.vaultQuarantineText`), which is what lets SB-090 move a reason without touching the wire.
 * @returns {import('../../shared/types.ts').VaultQuarantinedNote[]}
 */
function vaultQuarantinedNotes() {
  // GATED ON THE SHAPE, and this is a privacy check rather than an optimisation. Every other field
  // in `stateFor` is either stripped for employees, scoped to `user.id`, or admin-gated; this one
  // would hand any authenticated caller the absolute filesystem paths of the vault owner's daily
  // notes. Under `team` it happens to be empty today only because nothing writes `vault_index`
  // there — not because anything checked — and a `personal → team` switch leaves those rows behind.
  // Under `personal` there is exactly one user (DD-006 consequence 1), so there is nobody to leak to.
  if (activeShape() !== 'personal') return [];
  return store
    .listVaultIndex()
    .filter((row) => row.state === 'quarantined')
    .map((row) => ({
      path: row.path,
      date: row.date,
      reason: String(row.quarantineReason || ''),
      detectedAt: row.quarantinedAt ?? null,
    }));
}
/**
 * SB-133: the settings object AS IT GOES ON THE WIRE — `shape` is the value that was CHOSEN,
 * and ABSENT when nobody has chosen one. `getSettings()` keeps defaulting it to `team` for every
 * server-side reader, which is right (DD-015: `team` is the safe row); what is wrong is putting
 * that invented value in front of a client that PUTs the whole object back.
 *
 * That round trip was a live defect, not a tidiness point. An install started `TT_SHAPE=personal`
 * with nothing stored received `shape: 'team'` here, echoed it back with the first vault path
 * typed into Settings, and STORED it — and a stored value beats the env (SB-100's precedence,
 * working exactly as designed), so the backend derived to `sqlite` and the vault went quiet while
 * TT went on accepting hours. No error, no toast, no refusal: the silent divergence this whole
 * map exists to kill, arriving through the settings page.
 *
 * THE SEAM IS HERE AND NOT AT THE WRITE EDGE, because the write edge cannot tell the two apart.
 * An incoming `shape: 'team'` is either a person choosing Team or a client parroting a default it
 * was handed, and those are the same bytes; a server-side compare could only guess, and guessing
 * wrong in one direction stores a choice nobody made while guessing wrong in the other silently
 * swallows a real one. Nothing that was never SENT has to be guessed about. It also fixes the
 * class rather than the instance: the next instance-local field with a meaningful default would
 * do this again. (`mdDir` escapes only because its default is `''`, a value nobody can mean —
 * see the `getStoredShape` comment in db.js, which is the same distinction one field over.)
 *
 * The EFFECTIVE shape is not lost by this: it has its own field, `AppState.shape`, which is what
 * every client capability check already reads, and `shape?: Shape` in the type has said "absent
 * behaves as `team` AND is distinguishable from a stored `team`" since SB-100.
 * @returns {import('../../shared/types.ts').Settings & { mdDir: string }}
 */
function wireSettings() {
  const settings = store.getSettings();
  const stored = store.getStoredShape();
  if (stored) return { ...settings, shape: stored };
  const { shape: _defaulted, ...rest } = settings;
  return /** @type {import('../../shared/types.ts').Settings & { mdDir: string }} */ (rest);
}

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
    // SB-100: the EFFECTIVE shape, not the stored one — the env and the lock can both beat
    // the setting, and every client capability check reads this. Additive and read-only: this
    // pair is the one wire change SB-056 makes, and "the team shape comes out byte-for-byte
    // unchanged" is a claim about the DB and the mirror bytes, not about the envelope. The
    // BACKEND is not on the wire: it is derived from the shape (DD-015), never chosen.
    shape: activeShape(),
    shapeLocked: shapeLocked(),
    // SB-098: DD-015's open state. See shapeQuestionOpen — the client renders the question,
    // it does not decide whether it is being asked.
    shapeOpen: shapeQuestionOpen(user),
    // SB-065: a standing mirror refusal is STATE, not a log line — a mirror that has
    // quietly stopped updating still looks current, which is the failure this guards.
    mirrorBlocked: mirrorBlockFor(user),
    // SB-057: the same argument, one shape over. Under `personal` the vault IS the storage, so a
    // silently quarantined day is a day whose hours stop syncing with no signal anywhere. Read-only
    // and additive; empty under `team`, which has no vault. No resolution ACTION — SB-103 rules
    // what a human may do about one, and every option there is additive on top of this.
    vaultQuarantined: vaultQuarantinedNotes(),
    // SB-133: `wireSettings()`, never `store.getSettings()` — the defaulted `shape` must not
    // leave the server, because the client PUTs this object straight back.
    settings: wireSettings(),
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
 * SB-056 / DD-008: the commit capability gate. Returns the refusal message when this request
 * would CHANGE the ledger under a shape that cannot hold one, or null when it may proceed.
 *
 * A CHANGE, not the presence of a ledger: an install that committed weeks under `team` and
 * then switched keeps re-sending those segments on every debounce, and refusing them would
 * wedge it forever (see the call site). So the incoming key SET is compared against the stored
 * one — identical rides along, any difference is refused. Order and duplicates do not matter:
 * `commitLedgerError` has already rejected a repeated key with a 400 before this runs.
 *
 * The wording comes from `TT.shapeOffReason` so this and Task 7's on-screen explanation
 * cannot claim different things.
 * @param {number} userId @param {any[]} incoming @returns {string | null}
 */
function commitCapabilityRefusal(userId, incoming) {
  const reason = TT.shapeOffReason('committing', activeShape());
  if (!reason) return null;
  const stored = new Set(store.getCommits(userId).map((segment) => segment.key));
  const wanted = new Set(incoming.map((segment) => (segment == null ? undefined : segment.key)));
  if (stored.size === wanted.size && [...stored].every((key) => wanted.has(key))) return null;
  return reason;
}

/**
 * SB-102 / DD-017 §1: the FROZEN-DAY gate. Returns the refusal when this PUT would CHANGE
 * anything inside a day the personal shape holds read-only, or null when it may proceed.
 *
 * SHAPE-GATED AND ROLE-BLIND, and that is the entire point of DD-017. `pinCommittedEntries`
 * below cannot be reused for this: it runs `if (!admin)` and under `personal` the one user IS
 * the seeded admin (DD-015 depth 2), so the existing lock never fires for the only person there
 * is. It also PINS — silently reverting the edit — where this REFUSES, because a personal user
 * editing their own pre-vault history deserves to be told no rather than to watch a keystroke
 * evaporate.
 *
 * A CHANGE, NOT THE PRESENCE — same shape as `commitCapabilityRefusal` above and for the same
 * sharp reason. `db.putEntries` is DELETE-all-then-insert and the client PUTs its whole state,
 * so every frozen entry arrives on every debounce by construction; `useServerSync` re-queues any
 * non-409 failure and re-arms a 4 s timer forever, so refusing the presence of pre-vault history
 * would be a permanent toast loop for anyone with any history at all. Strictly worse than no
 * guard.
 *
 * Compared as SETS of canonicalised entries, which catches all four kinds of change at once: a
 * modified field, a row added, a row removed, and a row MOVED into or out of a frozen day (it is
 * in one subset and not the other). `TT.entryMatchKey` is the canonical form because it
 * normalises exactly the way `db.putEntries` does — project null→'', label/note trimmed, billable
 * truthy→1 — so a stored row re-sent by the client keys identically and cannot false-positive.
 * The id is prefixed because DD-017 freezes rows, not just their contents.
 *
 * `editedByAdmin` is deliberately not in the key: `pinEditedByAdmin` already pins it to the
 * stored value for every caller, so it cannot be moved through this route anyway.
 * @param {number} userId @param {any[]} incoming @returns {string | null}
 */
function frozenEntryRefusal(userId, incoming) {
  if (activeShape() !== 'personal') return null;
  /** The same context `vault-write.js` builds. No `admin` — the personal branch never reads it. */
  const ctx = {
    shape: 'personal',
    vaultCutover: store.getSettings().vaultCutover,
    commits: store.getCommits(userId),
  };
  /** @param {any[] | undefined} entries @returns {string[]} the frozen rows, canonical and sorted */
  const frozenSet = (entries) => {
    /** @type {string[]} */
    const keys = [];
    for (const entry of entries || []) {
      if (!entry || typeof entry.date !== 'string') continue;
      // U+001E, one level up from entryMatchKey's U+001F join, so no id can spell its way
      // into the date field and collide with a different row.
      if (TT.readOnlyDay(entry.date, ctx)) keys.push(String(entry.id) + '\u001E' + TT.entryMatchKey(entry));
    }
    return keys.sort();
  };
  const stored = frozenSet(store.getEntries(userId));
  const wanted = frozenSet(incoming);
  if (stored.length === wanted.length && stored.every((key, i) => key === wanted[i])) return null;
  return TT.FROZEN_ENTRY_REFUSAL;
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
  // SB-100, DC-002 again: with TT_SHAPE_LOCK set the shape is env-only. Compare against
  // the STORED value rather than rejecting the key — the client PUTs the whole settings object
  // on every currency edit, and a blanket 403 would wedge it: `useServerSync` re-queues any
  // non-409 failure and retries every 4 s forever, so an unchanged value has to ride along.
  //
  // SB-133: `getStoredShape()`, and now it really is the stored value the sentence above always
  // claimed. `getSettings().shape` defaults to `team`, so a locked install with nothing stored
  // used to let an incoming `team` through this guard and STORE it — a row the lock was there to
  // prevent, invisible until the day someone removed TT_SHAPE_LOCK and the install moved. The
  // ride-along is untouched: `stateFor` no longer sends a shape nobody chose, so an unchanged
  // settings object carries no `shape` key at all, and one that does carries the stored value.
  if (
    shapeLocked() &&
    body.settings &&
    body.settings.shape !== undefined &&
    String(body.settings.shape) !== store.getStoredShape()
  ) {
    return res.status(403).json({ error: 'the instance shape is locked by server configuration (TT_SHAPE_LOCK)' });
  }
  // SB-056 / DD-006 consequence 1, direction 2: refuse to switch TO `personal` while more than
  // one user exists. Same compare-not-reject shape as the two locks above — the client re-sends
  // the whole settings object, so this only fires on an actual CHANGE to `personal`.
  if (body.settings && body.settings.shape === 'personal' && store.getSettings().shape !== 'personal') {
    const users = db.listUsers().length;
    if (users > 1) return res.status(403).json({ error: shapeSwitchRefusal(users) });
  }
  // SB-056 / DD-008: committing is a CAPABILITY of the shape, and under `personal` there is
  // nowhere to persist a commit — the ledger belongs in weekly notes, which are phase 3.
  //
  // It refuses a CHANGE to the ledger, not its presence, which is the same shape the mdDir
  // lock takes and for a sharper reason: `useServerSync` re-queues any non-409 failure and
  // re-arms a 4 s timer forever, so a blanket 403 on `commits` would put anyone who committed
  // anything BEFORE the switch into a permanent toast loop on every keystroke they log.
  // Whether those pre-switch segments should still be RENDERED is SB-093, not this guard.
  if (body.commits !== undefined) {
    const refusal = commitCapabilityRefusal(req.user.id, body.commits);
    if (refusal) return res.status(403).json({ error: refusal });
  }
  // SB-102 / DD-017 §1: under `personal`, editable ⇔ vault-bound. A day that does not reach a
  // daily note cannot be typed into — and that has to be enforced HERE, not in the grid: a stale
  // tab, a second machine and a hand-rolled PUT all arrive at this route. Same compare-not-reject
  // shape as the guards above, so an unchanged frozen set rides along on every debounce.
  //
  // Before any write, and before `reconcileCommits`/`pinCommittedEntries` touch the body, so a
  // refused PUT writes nothing at all — a 403 raised after `putEntries` is indistinguishable from
  // outside the process.
  if (body.entries !== undefined) {
    const frozen = frozenEntryRefusal(req.user.id, body.entries);
    if (frozen) return res.status(403).json({ error: frozen });
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
  // SB-057: the vault the engine watches is a SETTING, so the engine has to be re-pointed when it
  // moves. Without this, configuring the vault folder for the first time does nothing until the
  // next restart — a personal install that looks wired up and syncs nothing, which is the exact
  // "perfect plumbing, no way to reach it" failure SB-063 already cost this repo once.
  //
  // `startVaultSync` stops first and is idempotent, so re-pointing at nothing correctly STOPS
  // watching rather than leaving a watcher on the old folder. The scan that follows is
  // fire-and-forget for the same reason the boot one is: a cold vault takes minutes and a save
  // must not wait for it.
  if (body.settings && (body.settings.vaultPaths !== undefined || body.settings.shape !== undefined)) {
    forgetOwnWrites(); // echo records are keyed by path, and the paths may have just moved
    if (startVaultSync())
      void scanVault().catch((err) =>
        console.error('[time-turtle] vault re-scan failed:', /** @type {Error} */ (err).message),
      );
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
    // SB-085's lesson, one shape over: the save that TRIPS a quarantine is the moment the client
    // should learn about it, not the next reload.
    vaultQuarantined: vaultQuarantinedNotes(),
  });
});

// ---- DD-024 clause 1: the first run, answered before the login it removes ----
//
// DD-015 said "ask, at first admin login". DD-024 amends exactly that clause, because it does not
// survive the shape it was written to introduce: in the open state the effective shape is `team`,
// `team` carries `identity: true`, so `GET /api/state` 401s and the client renders `<Login>` —
// and the gate that REMOVES the login is reachable only by clearing the login, with a password
// printed once into a detached log file the person it is for has no reason to open.
//
// So these two routes sit OUTSIDE `requireUser`. Nothing else does, and nothing else should: every
// future route hung here has to re-earn the gate below rather than inherit it. That is DD-024's
// own stated cost 1, and it is the cheapest wrong move available to a later session.
//
// DELIBERATELY NARROW (DD-024 deviation 1). `/api/state` is untouched and still 401s in the open
// state. Widening it would make every field it carries unauthenticated for the sake of one boolean.
const FIRST_RUN_CLOSED = 'the first run is over: this install has already answered what it is';
/**
 * Is the install in DD-015's OPEN STATE — the one configuration where the shape question has two
 * real answers and nobody has given one?
 *
 * The first two conditions of `shapeQuestionOpen`, and deliberately not a third copy of them: the
 * role condition drops out because there is no resolved user here, which is the entire point of
 * this surface. Re-derived per request rather than cached at boot, so an install that stores a
 * shape — or grows a second user — leaves the open state immediately rather than at the next
 * restart.
 * @returns {boolean}
 */
function firstRunOpen() {
  return shapeTarget().source === 'default' && db.listUsers().length === 1;
}
/**
 * Is this caller allowed to see the first-run surface at all?
 *
 * BOTH ADDRESS CHECKS, and the socket one is the load-bearing half. In the open state `BIND_HOST`
 * is `undefined` (see its comment above) so the server answers on EVERY INTERFACE — loopback is
 * not implied by anything here. SB-136's Host check alone does not survive that: `curl -H 'Host:
 * localhost' http://<lan-ip>:<port>/…` from any machine on the same wifi passes it, which is
 * SB-162, measured. The Host check stays anyway, because it stops a different attack — DNS
 * rebinding in the user's own browser arrives OVER LOOPBACK and is invisible to a peer check.
 * @param {Request} req @returns {boolean}
 */
function firstRunCaller(req) {
  return isLoopbackPeer(req.socket.remoteAddress) && isLoopbackHostHeader(req.headers.host);
}
/**
 * 404 — the same answer an unknown route gets, never a 403.
 *
 * A 403 confirms the surface EXISTS, which tells a scanner where to come back to once the install
 * is in a state it likes. Nothing about the caller is reflected back either.
 * @param {Response} res
 */
const notFound = (res) => res.status(404).json({ error: 'not found' });

// GET is readable from loopback FOREVER, and answers `open: false` once the question is
// answered — it does not start 404ing. The client needs a definite answer to decide whether to
// render the first run or `<Login>`, and "the route vanished" and "the server is down" are the
// same bytes to a browser. Only the PEER gate produces a 404 here, because that is the caller who
// must not learn the surface exists. Task 3 (SB-140) adds the vault prefill to this same payload,
// so the vault step costs no second round trip.
app.get('/api/first-run', (req, res) => {
  if (!firstRunCaller(req)) return notFound(res);
  res.json({ open: firstRunOpen() });
});

// POST is PERMANENTLY CLOSED once the question is answered — 409, not 404, because a loopback
// caller that just lost a race is entitled to know why rather than to think the route moved.
app.post('/api/first-run', (req, res) => {
  if (!firstRunCaller(req)) return notFound(res);
  if (!firstRunOpen()) return res.status(409).json({ error: FIRST_RUN_CLOSED });
  const { shape } = req.body || {};
  if (!TT.SHAPES.includes(shape))
    return res.status(400).json({ error: 'shape must be one of ' + TT.SHAPES.join(', ') });
  // THE SAME REFUSAL LIST THE OTHER TWO DOORS CARRY (DD-024 Amendment 1 §3). This is a third door
  // into one decision, never a third decision — `POST /api/shape` and `PUT /api/state` apply these
  // in this order and so does this. A door that refuses less than its siblings is a bypass.
  const refusal = shapeStoreRefusal(shape);
  if (refusal) return res.status(403).json({ error: refusal });
  // ONE PARTIAL `putSettings`, deliberately. SB-133 is the standing finding that a whole-settings
  // PUT flips an env-only `personal` install to `team`; this route must not be a second instance
  // of it. `putSettings` writes only the keys present and stamps the DD-016 cutover itself for
  // `personal`, so nothing that can store the shape can skip the stamp. Task 3 adds
  // `vaultPaths: { root }` to this same write.
  store.transaction(() => {
    store.putSettings({ shape });
  });
  res.json({ ok: true, shape });
});

// ---- SB-098 / SB-139: the deliberate shape-choosing gesture ----
//
// Choosing what this install IS is not a settings edit, and this is the channel that says so.
// SB-098 needed it: the first-run question must store an answer that is EQUAL to the shape
// already in force (an unstored install resolves to `team`, so "my company's" is the shape the
// user is already effectively on), and it must do that from a modal that holds no settings
// object to round-trip. Sending the whole settings object to answer one question is precisely
// the class of bug SB-133 just closed.
//
// WHY A POST AND NOT A 403 ON THE SHARED PUT. `useServerSync` re-queues any non-409 failure and
// re-arms a 4 s timer forever, so a blanket refusal on `PUT /api/state` wedges the client
// permanently — SB-139's stated constraint, and the reason the two existing shape guards
// compare against the stored value instead of rejecting the key. Nothing debounced or retried
// reaches this route, so it may refuse outright, loudly, the way SB-056 refuses a second user.
//
// SB-139 IS NOT CLOSED BY THIS. `PUT /api/state` still accepts `shape`, so a hand-rolled client
// can still store one without coming through here. Narrowing that is the other half of SB-139
// and it moves SB-100's guard suites, which this ticket was told to keep green and untouched —
// see the resolution comment on SB-098. What lands here is the channel, built once.
app.post('/api/shape', requireUser, requireAdmin, (req, res) => {
  const { shape } = req.body || {};
  if (!TT.SHAPES.includes(shape))
    return res.status(400).json({ error: 'shape must be one of ' + TT.SHAPES.join(', ') });
  // The same three refusals the shared PUT applies, in the same order — this is a second door
  // into one decision, never a second decision. DC-002: the lock is env-only and beats a write.
  if (shapeLocked())
    return res.status(403).json({ error: 'the instance shape is locked by server configuration (TT_SHAPE_LOCK)' });
  // DD-006 consequence 1, direction 2. Compared against the EFFECTIVE shape rather than the
  // stored one, because that is the shape the caller is actually moving away from.
  if (shape === 'personal' && activeShape() !== 'personal') {
    const users = db.listUsers().length;
    if (users > 1) return res.status(403).json({ error: shapeSwitchRefusal(users) });
  }
  // NO `bumpCatalogVersion()`, and that is a considered omission rather than a forgotten line.
  //
  // `shape` is instance-local: it never travels to the vault or the mirror, it is not one of the
  // catalog COLLECTIONS DC-001's version guards, and storing it cannot clobber another client's
  // edit — so there is no lost update for a bump to prevent here.
  //
  // Bumping it does real harm, measured: this route's caller reloads afterwards, and a reload
  // hands `useServerSync` a whole new state object while leaving its cached `versionRef` on the
  // pre-bump number (it is re-baselined only on the FIRST load and after a 409). Every reference
  // in the new state differs, so the hook immediately queues a full PUT — carrying the stale
  // version, straight into a 409. The client recovers by reloading, but the patch it was holding
  // is dropped by design, so the user's next keystrokes vanish with a "someone else saved first"
  // toast on a single-user install. The browser suite caught it as an empty markdown mirror.
  //
  // That staleness is a pre-existing defect on the `load()`-after-write paths (the Settings shape
  // toggle, renameProject, renameClient) and it is NOT fixed here: `useServerSync`'s 409 handling
  // is SB-105, which Terje is ruling separately. This route simply declines to add a new way in.
  store.transaction(() => {
    // putSettings stamps the DD-016 cutover for `personal` itself, so nothing that can store
    // the shape can skip it — including this route.
    store.putSettings({ shape });
  });
  // The vault the engine watches is decided by the shape, so re-point it here for the same
  // reason the settings PUT does: without this, answering "personal" leaves the sync engine
  // idle until the next restart.
  forgetOwnWrites();
  if (startVaultSync())
    void scanVault().catch((err) =>
      console.error('[time-turtle] vault re-scan failed:', /** @type {Error} */ (err).message),
    );
  console.log(`[time-turtle] instance shape chosen: ${shape} (stored)`);
  // The EFFECTIVE shape after the write, not the one that was asked for — they differ if a
  // lock or an env value is in play, and the caller reloads against what is actually in force.
  res.json({ ok: true, shape: activeShape(), version: store.getVersions(req.user.id) });
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

// SB-095: the cross-user READ that makes the line above reachable. `GET /api/state` reports
// only the session user's block, so an admin could neither see nor clear an employee's —
// even though the acknowledge route has taken `{userId}` since SB-065. The write plumbing
// was built and unreachable; this is the missing read.
//
// Shape follows SB-086 rather than inventing a third: several users' blocks come back as a
// LIST under the plural name (`mirrorBlocks`), where the one-mirror routes carry a singular
// `mirrorBlocked`. Each block additionally carries `userId`/`userName`, because the guard is
// keyed by PATH and the acknowledge call is keyed by USER — without the identity the admin
// has a report it cannot act on.
//
// The caller's own block is INCLUDED. "Every block on this instance" is a claim with no
// exception to remember, and the client already renders its own from /api/state, so it drops
// the duplicate there — one filter in one place beats a server-side carve-out.
app.get('/api/mirror/blocks', requireUser, requireAdmin, (req, res) => {
  /** @type {import('../../shared/types.ts').MirrorBlock[]} */
  const mirrorBlocks = [];
  for (const user of db.listUsers()) {
    const block = mirrorBlockFor(user);
    if (block) mirrorBlocks.push({ ...block, userId: user.id, userName: user.name });
  }
  res.json({ mirrorBlocks });
});

// ---- PLAN-013 / SB-115 / DD-018: the shape-switch preflight ----
//
// "What would this switch cost", answered by the server before the gesture. DD-018's ruling is
// that the numbers are COMPUTED, never asserted in prose — so SB-116's modal reads its 214 off
// this, and the boot banner reads the same numbers out of the same module with no HTTP in the
// room. A thin adapter on purpose: everything true about the answer lives in shape-preflight.js.
//
// SAME GATE AS `/api/mirror/blocks` ABOVE, and for the same reason: the `mirrors` list is other
// users' file paths. `requireUser, requireAdmin`. The entry and commit counts are the CALLER's
// own (`req.user.id`) — no other user's entry content leaves this route.
//
// `to` EQUAL TO THE CURRENT SHAPE IS ANSWERED NORMALLY, not refused. This is a read; what to do
// about a no-op switch is the caller's business, and a 409 here would make the modal special-case
// a state it can already see.
app.get('/api/shape/preflight', requireUser, requireAdmin, (req, res) => {
  const to = req.query.to;
  if (typeof to !== 'string' || !TT.SHAPES.includes(/** @type {any} */ (to)))
    return res.status(400).json({ error: 'to must be one of ' + TT.SHAPES.join(', ') });
  res.json(shapePreflight(req.user.id, to));
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
    // SB-133: the same rule as `stateFor` — both OUTBOUND seams say what was chosen, so no
    // client anyone writes against either of them can echo a default back as a decision.
    settings: wireSettings(),
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
  // SB-102 / DD-017 §1 — END-GATE REVIEW FINDING, DELIBERATELY NOT FIXED HERE. See SB-149.
  //
  // This route writes entries and does NOT consult `frozenEntryRefusal`, so under `personal` a
  // hand-rolled PUT changes a pre-vault or frozen day that `PUT /api/state` refuses. Measured
  // against a live server: the guarded route said 403, this one said 200 and stored the edit.
  // `requireAdmin` gates nothing here — the one user IS the seeded admin (DD-015 depth 2).
  //
  // It is left open on purpose rather than overlooked. Closing it means reversing the ruling
  // written out at the ledger-write site below — "the ENTRY edit still lands… It is the ledger
  // that is frozen, not the timesheet" — which a previous end-gate review put there with its
  // reasoning, and which `tests/shape-committing.test.js` asserts. DD-017 §1 says the opposite
  // for `personal`. Two recorded rulings disagree, and picking the winner is not a call an
  // executing agent gets to make quietly, so it is filed with the evidence instead.
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
      // SB-056 / DD-008: the THIRD ledger-write site, and the one the first pass missed. Under
      // `personal` the re-freeze is skipped and the stored ledger is left verbatim — the ENTRY edit
      // still lands, because refusing it would wedge an admin out of correcting any week that
      // was ever committed, which is the same failure the ride-along exists to prevent. It is
      // the ledger that is frozen, not the timesheet. (Whether pre-switch segments should still
      // be rendered at all is SB-093, not this guard.)
      //
      // SB-102 / DD-017 §1 CONTRADICTS THE SENTENCE ABOVE for `personal`, where editable ⇔
      // vault-bound makes the timesheet frozen too. Both rulings are currently in the repo and
      // one of them has to be withdrawn in writing. SB-149 carries the evidence and the choice;
      // until it is ruled, this route behaves exactly as it did before PLAN-015.
      if (commitsChanged && !TT.shapeOffReason('committing', activeShape())) store.putCommits(id, reFrozen);
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
    // SB-056 / DD-008: approve and release are ledger WRITES, so the same capability gate
    // covers them. Refused outright rather than compared: unlike the collection-replace PUT
    // above, these are deliberate one-shot verbs — nothing re-sends them on a debounce, so
    // there is no ride-along to preserve and a flat refusal cannot wedge anything.
    const off = TT.shapeOffReason('committing', activeShape());
    if (off) return res.status(403).json({ error: off });
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
  // SB-056 / DD-006 consequence 1, direction 1: refuse a second user while `personal` is on.
  // Before `db.createUser` is reached, so a refusal really does leave the user table alone.
  // There is no sane answer to whose Calendar/Daily/2026-07-26.md two employees' entries land
  // in, which is why this is ruled out by construction rather than deferred to a merge story.
  if (singleUserShape()) return res.status(403).json({ error: SECOND_USER_REFUSAL });
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
// SB-056: same lesson, same shape, for the instance shape. Which source won is the whole point
// — "TT_SHAPE=personal but the stored setting says team" is otherwise invisible until someone
// runs a census. The BACKEND is printed too, but as a DERIVATION (DD-015) and never as a
// second source: it has no env var and no setting of its own to disagree with.
const SHAPE_SOURCE = {
  'env-locked': 'TT_SHAPE, frozen by TT_SHAPE_LOCK',
  setting: 'shape setting',
  env: 'TT_SHAPE',
  default: 'default',
};

// SB-098: `{ port, host }` rather than `listen(PORT)`. `host: undefined` is the historical
// every-interface bind, which is what `team` keeps; under `personal` BIND_HOST is loopback and
// the boot block above has already refused every TT_HOST that would make it anything else.
app.listen({ port: PORT, host: BIND_HOST }, () => {
  const shape = shapeTarget();
  const target = mirrorTarget();
  console.log(
    `[time-turtle] api on http://localhost:${PORT}  ·  shape: ${shape.shape}  (${SHAPE_SOURCE[shape.source]})  ·  storage: ${shape.backend}`,
  );
  // Which interfaces answer is not a detail when there is no login. Said out loud on the first
  // line of the log, in the same breath as the shape that decided it (SB-073's lesson).
  console.log(
    BIND_HOST
      ? `[time-turtle] bound to ${BIND_HOST} only — this instance is not reachable from other machines`
      : '[time-turtle] bound to every interface — reachable from other machines on this network',
  );
  if (shape.shadowed)
    console.log(
      `[time-turtle] the stored shape setting overrides TT_SHAPE=${shape.shadowed} — that shape is not in use`,
    );
  // SB-056 design decision 3: `personal` is selectable BEFORE SB-057 fills the vault store in,
  // because SB-056's own required evidence needs it selectable and DD-011's retirement is
  // present tense. The cost is real and is said out loud here rather than discovered.
  if (shape.shape === 'personal')
    console.log(
      '[time-turtle] personal shape: the markdown mirror is off (DD-011), committing is off until phase 3 (DD-008), and markdown paste-back is off',
    );
  // SB-057: the sync engine starts AFTER the server is answering, deliberately. A cold boot scan
  // over evicted days is a serial run of ~1 s blocking downloads (SB-052), and `tt serve` spawns
  // detached — so a scan that ran before `listen` would look exactly like a hang, on a process
  // nobody can see. The watcher and the interval are started first so a note landing during the
  // scan is not missed; the scan itself is fire-and-forget.
  const started = startVaultSync();
  if (started) {
    const config = vaultSyncConfig();
    console.log(`[time-turtle] vault sync → ${config ? config.dailyDir : '?'}  (watch + interval)`);
    void scanVault()
      .then((counts) => {
        const summary = Object.entries(counts)
          .map(([verdict, n]) => `${n} ${verdict}`)
          .join(', ');
        console.log(`[time-turtle] vault boot scan: ${summary || 'no daily notes yet'}`);
      })
      .catch((err) => console.error('[time-turtle] vault boot scan failed:', /** @type {Error} */ (err).message));
  } else if (shape.shape === 'personal') {
    console.log('[time-turtle] vault sync is idle: no vault folder is configured (Settings → Vault)');
  }
  console.log(
    `[time-turtle] markdown mirror → ${target.dir}  (${MIRROR_SOURCE[target.source]})${shape.shape === 'personal' ? '  — not written in the personal shape' : ''}`,
  );
  if (target.shadowed)
    console.log(
      `[time-turtle] the stored mdDir setting overrides TT_MD_DIR ${target.shadowed} — nothing is written there`,
    );
});
