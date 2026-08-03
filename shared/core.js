// @ts-check
// Time Turtle core: parsing, model, markdown serialization.
// Shared between client (UI + i18n overrides) and server (markdown mirror).
/** @typedef {import('./types.ts').Entry} Entry */
/** @typedef {import('./types.ts').VaultEntry} VaultEntry */
/** @typedef {import('./types.ts').Task} Task */
/** @typedef {import('./types.ts').Project} Project */
/** @typedef {import('./types.ts').Client} Client */
/** @typedef {import('./types.ts').Rounding} Rounding */
/** @typedef {import('./types.ts').Settings} Settings */
/** @typedef {import('./types.ts').Catalog} Catalog */
/** @typedef {import('./types.ts').ParsedTime} ParsedTime */
/** @typedef {import('./types.ts').VaultTimeSeparator} VaultTimeSeparator */
/** @typedef {import('./types.ts').TTModule} TTModule */

// Populated incrementally below; casting an empty object to TTModule lets each
// assignment get its parameter types by contextual typing from the interface.
const TT = /** @type {TTModule} */ (/** @type {unknown} */ ({}));
/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');
TT.fmtT = (min) => {
  min = ((min % 1440) + 1440) % 1440;
  return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);
};
TT.fmtDur = (min) => {
  min = Math.round(min);
  const h = Math.floor(min / 60),
    m = min % 60;
  return h && m ? h + 'h' + m + 'm' : h ? h + 'h' : m + 'm';
};
TT.fmtHours = (min) => {
  const h = Math.round((min / 60) * 100) / 100;
  return String(h);
};
TT.fmtMoney = (n, cur) => {
  const s = Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return s + ' ' + (cur || 'kr');
};

/** @param {string} s @returns {number | null} */
function tok(s) {
  // "9", "09", "9:30", "0930" -> minutes
  const match = /^(\d{1,2}):?(\d{2})?$/.exec(s.trim());
  if (!match) return null;
  const h = +match[1],
    mm = match[2] ? +match[2] : 0;
  if (h > 24 || mm > 59 || (h === 24 && mm > 0)) return null;
  return h * 60 + mm;
}
// Returns {kind:'range',start,end} | {kind:'running',start} | {kind:'duration',min} | null
TT.parseTimeCell = function (raw) {
  let s = String(raw).trim().toLowerCase().replace(/→|->/g, '>').replace(/–/g, '-').replace(/,/g, '.');
  if (!s) return null;
  let match = /^([\d:]{1,5})\s*[->]$/.exec(s); // running: "12:30>", "12:30-"
  if (match) {
    const start = tok(match[1]);
    if (start != null) return { kind: 'running', start };
  }
  match = /^([\d:]{1,5})\s*(?:>|-|\bto\b)\s*([\d:]{1,5})$/.exec(s);
  if (match) {
    const a = tok(match[1]),
      b = tok(match[2]);
    if (a != null && b != null) return { kind: 'range', start: a, end: b };
  }
  match = /^(?:(\d+(?:\.\d+)?)\s*(?:hrs?|h|t))?\s*(?:(\d+)\s*(?:mins?|m))?$/.exec(s);
  if (match && (match[1] || match[2])) {
    const min = Math.round((match[1] ? +match[1] * 60 : 0) + (match[2] ? +match[2] : 0));
    if (min > 0) return { kind: 'duration', min };
  }
  return null;
};
// SB-063: which characters the VAULT daily note writes between a start and an end time is a
// setting (`Settings.vaultTimeSeparator`), because the three forms differ only in how they
// render — parseTimeCell above has accepted all three since SB-055, so flipping the setting
// never requires a vault migration. That is the whole reason this is cheap.
//   unicode  `→`   the DEFAULT: an arrow everywhere, with no font dependency
//   ascii    `->`  composes into a long-arrow ligature under JetBrains Mono / Fira Code /
//                  Cascadia, and degrades to two literal characters everywhere else — which
//                  is exactly why it is NOT the default (Terje, SB-063: "if it's dependant
//                  on a ligature, revert to the short arrow")
//   hyphen   `-`   matches the hand-written daily notes that predate the cutover
/** @type {Record<string, string>} */
const TIME_SEPARATORS = { unicode: '→', ascii: '->', hyphen: '-' };
const TIME_SEPARATOR_DEFAULT = TIME_SEPARATORS.unicode;
/**
 * Resolve a `Settings.vaultTimeSeparator` VALUE NAME to the characters to emit. Absent or
 * unrecognised resolves to `→`, today's behaviour — a setting may change how a note LOOKS,
 * never whether it can be written. Note the argument is the name, never raw characters:
 * arbitrary strings must not be able to reach a table cell and split their own row.
 * @param {string | null} [name] @returns {string}
 */
TT.timeSeparator = (name) => (name && TIME_SEPARATORS[name]) || TIME_SEPARATOR_DEFAULT;
/** The legal `Settings.vaultTimeSeparator` values, default first. The ONE home of this list. */
TT.TIME_SEPARATOR_VALUES = /** @type {string[]} */ (Object.keys(TIME_SEPARATORS));

// ---- SB-056 / SB-100: the instance shapes, and what each is allowed to do ----
//
// THE CAPABILITY TABLE LIVES HERE, in shared code, because both sides consult it: the server
// guards that REFUSE the operation (server/src/index.js) and the client surfaces that explain
// why the verb is missing (WeekView, Settings → Markdown mirror). One table read at CALL TIME
// is what makes DD-011's ruling structural — "the rule is a property of the SHAPE, not of a
// path captured at switch time" — instead of a convention repeated in six places that drift.
//
// ADD A NEW CAPABILITY HERE FIRST, then the guard, then the surface. A capability that exists
// only at the guard is a rule the UI cannot explain, which is the exact failure DD-008's
// comment names ("switching shapes silently losing a shipped feature reads as a bug months
// later").
//
// DD-015 KEYS THIS ON THE SHAPE AND NOT THE BACKEND. If "personal but not an Obsidian user"
// ever turns up it is a third SHAPE — one more row here — never a second axis, because
// shape × backend as orthogonal fields would legitimise team + vault: a shared server writing
// every employee's hours into one person's vault.
/** @type {Record<string, import('./types.ts').ShapeCapabilities>} */
const SHAPE_CAPABILITIES = {
  // The repo default and the company deployment. Everything on; SB-069 froze these bytes.
  team: { mirror: true, committing: true, mdImport: true, identity: true },
  // DD-006/DD-008/DD-011. The vault's daily notes are the markdown surface, so the v2
  // `|`-mirror stops (and is retired — see retireMirrors in server/src/markdown.js) and
  // paste-back, a WRITE path into the store from mirror bytes, goes with it. Committing is
  // off until phase 3 lands the weekly-note rollup that gives the ledger somewhere to live.
  // SB-098 adds `identity`: DD-015 depth 2 — one human, so there is nobody to be told apart
  // from, no role to hold and no session to sign out of.
  personal: { mirror: false, committing: false, mdImport: false, identity: false },
};
/** DD-015: the backend each shape DERIVES. Nobody selects a backend; this is the whole map. */
const SHAPE_BACKEND = /** @type {Record<string, import('./types.ts').Backend>} */ ({
  team: 'sqlite',
  personal: 'vault',
});
/** The legal `Settings.shape` values, safe default (`team`) first. The ONE home of this list. */
TT.SHAPES = /** @type {import('./types.ts').Shape[]} */ (/** @type {unknown} */ (Object.keys(SHAPE_CAPABILITIES)));
/**
 * What this shape may do. An UNKNOWN name resolves to the `team` row rather than throwing:
 * this is read on every render and in every guard, and a settings value from a newer TT (or a
 * hand-edited row) must degrade to today's shipped behaviour, never blank the Week view or
 * 500 a save. The place an unknown value is REJECTED is the write — `putSettings` whitelists
 * against TT.SHAPES — so a bad name cannot get in here through the app in the first place.
 * @param {string | null} [shape] @returns {import('./types.ts').ShapeCapabilities}
 */
TT.shapeCapabilities = (shape) => (shape && SHAPE_CAPABILITIES[shape]) || SHAPE_CAPABILITIES.team;
/**
 * The storage backend this shape derives (DD-015). Same safe-row rule as the capabilities: an
 * unknown name reads as `team`'s `sqlite` rather than throwing, because the alternative on a
 * hand-edited row is a server that will not boot.
 * @param {string | null} [shape] @returns {import('./types.ts').Backend}
 */
TT.backendFor = (shape) => (shape && SHAPE_BACKEND[shape]) || SHAPE_BACKEND.team;

// ---- why a note stopped syncing, in words a person can act on (SB-057 task 8) ----
//
// THE FRAME, and it is the whole point: *Time Turtle cannot prove it wrote this block, so it has
// stopped writing to this note.* It never says the hours were corrupted, because two of the
// commonest reasons are not damage at all:
//
//   • `verified: false` on an ADOPTED note is not damage (SB-091 rider 3). The adopted anchor
//     deliberately carries no digest — one computed at adoption time would be taken over the very
//     bytes it is meant to check.
//   • `digest-mismatch` after Obsidian's table editor reflows cell padding is not damage either
//     (SB-080's stated trade-off). The digest is over RAW LINE BYTES on purpose, so a purely
//     cosmetic reflow trips it. The line below says "does not match" and offers the reflow as the
//     first explanation, in that order, because crying wolf about someone's hours is worse than
//     being vague.
//
// English, because the server has no locale — the Norwegian UI translates these in
// client/src/i18n.ts, where the CLAIM must match rather than the bytes (the SHAPE_OFF_REASONS
// discipline). A reason the map does not know degrades to a GENERIC line rather than a blank:
// SB-090 already moved eight goldens onto a new reason name, and a surface that renders nothing
// for an unfamiliar code is a note that silently stops syncing — which is the failure this whole
// task exists to prevent. Catalog-only reasons are deliberately absent and take the fallback: no
// daily-note row can carry one until the catalog is wired to the engine.
/** @type {Record<string, string>} */
const VAULT_QUARANTINE_REASONS = {
  'no-heading': 'the Time Log heading is not in this note.',
  'crlf-line-endings': 'this note uses Windows line endings, which Time Turtle will not rewrite.',
  'multiple-headings': 'this note has more than one Time Log heading, so nothing can say which is the day’s.',
  'no-revision': 'the block has no revision line, and its contents are not ones Time Turtle can describe.',
  'malformed-revision': 'the revision line is there but Time Turtle cannot read it — its short fingerprint is damaged.',
  'revision-past-next-heading':
    'the revision line sits in a later section, so the block has no end Time Turtle trusts.',
  'multiple-revisions': 'the block has more than one revision line.',
  'no-table': 'there is no table under the heading.',
  'unexpected-content-in-block': 'there is something under the heading that is not part of the table.',
  'digest-mismatch':
    'the block’s fingerprint does not match the table it labels. Often this is only a table editor reflowing the spacing; it can also mean another machine’s edit was merged in.',
  'unknown-header': 'the table has a column Time Turtle does not know.',
  'duplicate-header': 'the table has the same column twice.',
  'row-cell-count': 'a row has a different number of cells than the header.',
  'unparseable-time': 'a Time cell is not one Time Turtle can read.',
  'bad-bill-cell': 'a Bill cell is neither a check mark nor blank, and that cell decides money.',
  'write-would-corrupt': 'what Time Turtle would write here is something it could not read back.',
  // the two arbitration verdicts (server/src/vault-arbitrate.js)
  'external-rewrite':
    'this note went back to an earlier revision with contents Time Turtle did not write — a restore from history, or another editor.',
  'unprovable-staleness':
    'this note’s revision is older than the one Time Turtle recorded, and Time Turtle has no record of it — so it cannot tell an out-of-date copy from a deliberate restore.',
};
/** The line every quarantine opens with. One home, so the server and the screen cannot drift. */
TT.VAULT_QUARANTINE_HEADLINE = 'Time Turtle cannot prove it wrote this block, so it has stopped writing to this note.';
/** The generic line for a reason this build does not know — never a blank. */
TT.VAULT_QUARANTINE_FALLBACK = 'Time Turtle refused this note and did not say why in words this version knows.';
/**
 * Why this note stopped syncing, as a sentence. Never throws and never returns an empty string:
 * an unknown reason takes the generic line.
 * @param {string | null | undefined} reason @returns {string}
 */
TT.vaultQuarantineText = (reason) => (reason && VAULT_QUARANTINE_REASONS[reason]) || TT.VAULT_QUARANTINE_FALLBACK;

/**
 * What every rule in this family reads. The SAME object `vaultBound` has always taken, plus an
 * optional `admin` that ONLY `readOnlyDay`'s `team` branch looks at.
 *
 * IMPORTED, not restated — the shape is declared once, in types.ts, the way this file already
 * refers to `CommitSegment`. A hand-copied duplicate had already drifted (`commits` nullable here
 * and not there) before the ink was dry, which is the whole argument in one line.
 * @typedef {import('./types.ts').VaultRuleContext} VaultRuleContext
 */

/**
 * IS THIS ENTRY THE VAULT'S? — DD-016 + DD-017, and SB-100 hands it to SB-057 by name.
 *
 * A non-vault-bound entry is written to SQLite and NEVER to a daily note, and never triggers
 * DD-012 adoption on its behalf. Three conditions, and each one closes a specific hazard:
 *
 *   1. THE SHAPE. Only `personal` has a vault at all.
 *   2. THE CUTOVER (DD-016). `TT.seedMd()` dates its demo entries relative to FIRST BOOT — `T`,
 *      `T-1`, `T-2`, `T-7`, `T-8`, `T-9` (see the seed below) — so without this a fresh personal
 *      install ADOPTS six of Terje's real daily notes and writes Fjellheim AS demo hours into
 *      them. The cutover is stored as an ISO instant and compared day-grained, because
 *      `Entry.date` is a day; `stampVaultCutover` stores the finer value precisely so this can
 *      choose, and `''` (never stamped) means no history is excluded.
 *   3. THE LEDGER (DD-017). `TT.weekSegments` cuts on (ISO week ∩ month) and NEVER on a date, so
 *      committing the current week and then switching mid-week leaves a frozen money snapshot
 *      astride the cutover. A committed segment stays whole: not one of its days reaches a note.
 *
 * ONE HOME, deliberately. SB-102 wants the same predicate; whoever lands first writes it and the
 * second consumes it. A second copy is a rule that agrees today and diverges on the first ruling.
 * PLAN-012 landed first, so SB-102/PLAN-015 did not write a second copy: clauses 2 and 3 moved
 * DOWN into `TT.preCutover` and `TT.frozenSegment` and this composes them. The signature, the
 * guards and the return value on every input are unchanged — PLAN-013 is filed against them.
 *
 * SKIPPED, NOT REFUSED, at the call site: `useServerSync` re-queues any non-409 failure and
 * retries every 4 s forever, so turning this into a 403 would be a permanent toast loop for
 * anyone with pre-cutover history.
 * @param {Entry} entry
 * @param {{ shape?: string | null, vaultCutover?: string | null, commits?: import('./types.ts').CommitSegment[] }} context
 * @returns {boolean}
 */
TT.vaultBound = function (entry, context) {
  const ctx = context || {};
  if (ctx.shape !== 'personal') return false;
  if (!entry || typeof entry.date !== 'string') return false;
  return !TT.preCutover(entry.date, ctx) && !TT.frozenSegment(entry.date, ctx);
};

/**
 * DOES THE LEDGER HOLD THIS DAY'S SEGMENT? — the one MEMBERSHIP scan the read-only rule family
 * shares (PLAN-015).
 *
 * Deliberately shape-blind and role-blind: it answers a question about the ledger and nothing
 * else. Every rule in the family gates THIS rather than writing the walk again — `frozenSegment`
 * under `personal`, `readOnlyDay`'s `team` branch (SDD-002 ruling 6), and through `readOnlyDay`
 * the client's whole lock expression (`TimeGrid.tsx`), which is where the second copy used to be.
 *
 * NOT the only code in the repo that walks the ledger, and the narrower claim is the honest one:
 * `viewUtils.isApproved`, `TT.commitSnapshot` and `TT.monthSegments` walk it too. They ask
 * different questions — is it approved, what money was frozen, what does the month roll up to —
 * so routing them through here would couple four rules to make one grep tidier. What must not
 * exist twice is *this* question, because two answers to "is this day frozen" is a rule that
 * agrees today and diverges on the first ruling.
 *
 * Null holes are survivable: the server strips the money snapshot per role and a client's ledger
 * has been through JSON both ways.
 * @param {string} date a `YYYY-MM-DD` day
 * @param {import('./types.ts').CommitSegment[] | null | undefined} commits
 * @returns {boolean}
 */
TT.committedOn = function (date, commits) {
  if (typeof date !== 'string') return false;
  const key = TT.segmentKey(date);
  for (const segment of commits || []) if (segment && segment.key === key) return true;
  return false;
};

/**
 * IS THIS DAY OLDER THAN THE VAULT? — `vaultBound`'s cutover clause (DD-016), on its own.
 *
 * Day-grained on purpose: `vaultCutover` is stored as an ISO instant so this can choose, and
 * `Entry.date` is a day. `''` (never stamped) excludes no history at all. Only `personal` has a
 * cutover — under `team` there is no vault to predate.
 * @param {string} date @param {VaultRuleContext} context @returns {boolean}
 */
TT.preCutover = function (date, context) {
  const ctx = context || {};
  if (ctx.shape !== 'personal') return false;
  if (typeof date !== 'string') return false;
  const cutoverDay = String(ctx.vaultCutover || '').slice(0, 10);
  return cutoverDay !== '' && date < cutoverDay;
};

/**
 * IS THIS DAY INSIDE A FROZEN SEGMENT? — `vaultBound`'s ledger clause (DD-017 §2), on its own.
 *
 * A committed segment never splits: `TT.weekSegments` cuts on (ISO week ∩ month) and never on a
 * date, so committing a week and then switching leaves a frozen money snapshot astride the
 * cutover, and the ledger wins over the date for ALL SEVEN of its days — including the ones
 * after the cutover, which the date clause alone would wave through.
 * @param {string} date @param {VaultRuleContext} context @returns {boolean}
 */
TT.frozenSegment = function (date, context) {
  const ctx = context || {};
  if (ctx.shape !== 'personal') return false;
  if (typeof date !== 'string') return false;
  return TT.committedOn(date, ctx.commits);
};

/**
 * CAN THIS DAY BE TYPED INTO? — DD-017 §1, and the rule the grid and the server both read.
 *
 * Under `personal`, `readOnlyDay` is the EXACT COMPLEMENT of `vaultBound`: editable ⇔ vault-bound.
 * Anything you can type into reaches a daily note; anything that does not reach a daily note you
 * cannot type into. That is not a comment — `tests/core.test.js` executes it over every personal
 * row of its table, because two predicates that agree today and diverge on the first ruling is
 * exactly the failure the one-home discipline exists to prevent.
 *
 * `ctx.admin` is read by the `team` branch and NOWHERE ELSE, and that is the point of the whole
 * plan: the committed-segment admin exemption (SDD-002 ruling 6) is a `team` concept, and under
 * `personal` the one user IS the seeded admin (DD-015 depth 2), so a role-gated lock never fires
 * for the person it is meant to protect. If SB-098 later removes the role concept from the UI,
 * this line is the only reader of `admin` in the rule.
 * @param {string} date @param {VaultRuleContext} context @returns {boolean}
 */
TT.readOnlyDay = function (date, context) {
  const ctx = context || {};
  if (typeof date !== 'string') return false;
  if (ctx.shape === 'personal') return TT.preCutover(date, ctx) || TT.frozenSegment(date, ctx);
  return !ctx.admin && TT.committedOn(date, ctx.commits);
};

/**
 * Where inside the vault TT reads and writes, when nothing has been chosen. HERE, not in
 * server/src/db.js and not in the client's fallback, because SB-057/SB-058 extend this shape
 * ADDITIVELY: the moment they add a key, a second copy silently produces a `VaultPaths` missing
 * it. `timeLogHeading` is a setting with a default and never a constant (SB-057).
 * @type {import('./types.ts').VaultPaths}
 */
TT.VAULT_PATHS_DEFAULT = {
  root: '',
  daily: 'Calendar/Daily',
  weekly: 'Calendar/Weekly',
  catalog: 'Time Turtle/Catalog.md',
  timeLogHeading: 'Time Log',
};

// WHY a capability is off, worded ONCE. The server puts this in the 403 body and the client
// puts it on screen where the verb used to be, so the two cannot drift in what they claim —
// and drift here is not cosmetic. SB-056's ruling is that this must not be a hidden disabled
// button: "switching shapes silently losing a shipped feature is the kind of thing that
// reads as a bug months later. Whatever form it takes, it should say WHY it is off and that
// phase 3 restores it."
//
// The recovery each one names is a SHAPE and not a backend (DD-015): "switch back to the
// sqlite backend" is an instruction nobody can follow any more, because there is no control
// that selects a backend.
//
// English, because the server has no locale. The Norwegian UI translates these in i18n.ts;
// the CLAIM is what must match, not the bytes.
//
// `identity` DELIBERATELY HAS NO ENTRY, and that is not an omission. Every reason here explains
// a verb that is VISIBLY MISSING from a surface that still exists — the commit button, the
// apply-markdown button. `identity: false` removes the surfaces themselves (DD-015 depth 2:
// Users, roles, passwords, review, the login screen), so there is no control left to carry an
// explanation, and nobody to read one: under `personal` the one human already knows they are
// the only one. `TT.shapeOffReason('identity')` therefore reads null, which is the honest answer.
/** @type {Record<string, string>} */
const SHAPE_OFF_REASONS = {
  committing:
    'committing is off in the personal shape: the commit ledger lives in weekly notes, which phase 3 adds — a per-machine SQLite ledger would diverge silently (DD-008). Switch back to the team shape to commit.',
  mdImport:
    'applying markdown edits is off in the personal shape: the vault’s daily notes are the markdown surface now, and the v2 mirror files this would restore from are no longer maintained (DD-011). Copy and download still work.',
  mirror:
    'the markdown mirror is off in the personal shape: the vault’s daily notes are the markdown surface, and two markdown copies of the same hours in one vault is what this avoids (DD-011).',
};
/**
 * WHY A FROZEN DAY REFUSED THE EDIT — DD-017 §1's other half, worded once (SB-102).
 *
 * NOT a row in SHAPE_OFF_REASONS above, deliberately: nothing here is "off". Committing is a
 * capability the shape does not have; this is a day that is read-only *because the hours in it
 * are not the vault's*, in a shape where the two are exact complements (`TT.readOnlyDay` is
 * `TT.vaultBound` negated). Same discipline though — the server puts this in the 403 body,
 * `useServerSync` toasts it VERBATIM, and `client/src/i18n.ts` carries the Norwegian with the
 * English side copied byte-for-byte. Edit one, edit the other in the same commit.
 *
 * DD-017 §4 governs every word of it. It says what is frozen and that the hours are already
 * saved. It does NOT promise that phase 3 will import anything — there is no importer and
 * §4 forbids implying one. And it never says `cutover` or `pre-cutover`: those are the repo's
 * words, and Terje's ruled vocabulary for the same fact is "before your vault".
 * @type {string}
 */
TT.FROZEN_ENTRY_REFUSAL =
  'these hours are read-only: the day is from before your vault, or it sits inside a week you committed. They are already saved exactly as they are — Time Turtle keeps them and will not rewrite them.';

/**
 * Why a capability is unavailable under this shape, or null when it IS available.
 * @param {keyof import('./types.ts').ShapeCapabilities} capability
 * @param {string | null} [shape] @returns {string | null}
 */
TT.shapeOffReason = (capability, shape) =>
  TT.shapeCapabilities(shape)[capability] ? null : (SHAPE_OFF_REASONS[capability] ?? null);
/**
 * @param {Entry} entry
 * @param {VaultTimeSeparator} [separator] a `Settings.vaultTimeSeparator` value name. Defaults to
 *   `unicode`, which is what every NON-vault caller wants and must keep getting: this
 *   formatter also serves the v2 mirror's entry lines, whose bytes SB-069 froze
 *   (the `team` shape comes out of the vault effort byte-for-byte identical), and the app's
 *   own UI has no daily note to match. Only TT.serializeVaultBlock passes this.
 * @returns {string}
 */
TT.fmtTimeCell = function (entry, separator) {
  if (entry.durMin != null) return TT.fmtDur(entry.durMin); // a duration has no separator
  const sep = TT.timeSeparator(separator);
  if (entry.start != null) return TT.fmtT(entry.start) + sep + (entry.end != null ? TT.fmtT(entry.end) : '');
  return '';
};
TT.nowMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
TT.isRunning = (entry) => entry.durMin == null && entry.start != null && entry.end == null;
// Minutes worked; overnight ranges (end < start) roll into next day
TT.entryMinutes = function (entry) {
  if (entry.durMin != null) return entry.durMin;
  if (entry.start == null) return 0;
  let end = entry.end;
  if (end == null) end = entry.date === TT.todayStr() ? TT.nowMin() : entry.start;
  let minutes = end - entry.start;
  if (minutes < 0) minutes += 1440;
  return minutes;
};

// dates
TT.todayStr = () => TT.dateStr(new Date());
TT.dateStr = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
TT.parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
TT.addDays = (s, n) => {
  const d = TT.parseDate(s);
  d.setDate(d.getDate() + n);
  return TT.dateStr(d);
};
TT.isoWeek = function (s) {
  const d = TT.parseDate(s);
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const y = dt.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jd = (jan4.getUTCDay() + 6) % 7;
  jan4.setUTCDate(jan4.getUTCDate() - jd + 3);
  return { week: 1 + Math.round((dt.getTime() - jan4.getTime()) / 604800000), year: y };
};
TT.weekDates = function (anchor) {
  // Mon..Sun of the week containing anchor date-string
  const d = TT.parseDate(anchor);
  const off = (d.getDay() + 6) % 7;
  const mon = TT.addDays(anchor, -off);
  return Array.from({ length: 7 }, (_, i) => TT.addDays(mon, i));
};
// SDD-002 ruling 4: the commit unit is an (ISO week ∩ calendar month) SEGMENT.
// A key is `${isoWeekYear}-W${pad2(week)}-${YYYY-MM}` — the ISO week-year+week, then
// the calendar month of the slice. All 7 days of a Mon..Sun week share one ISO
// week, so a segment key differs only by month: a month-straddling week yields two
// keys (a Dec/Jan week straddles year+month and still yields exactly two, with the
// correct ISO week-years); a non-straddling week yields one.
TT.segmentKey = function (dateStr) {
  const { week, year } = TT.isoWeek(dateStr);
  return year + '-W' + pad2(week) + '-' + dateStr.slice(0, 7);
};
// The 1-or-2 committable segments of the week containing `anchor`, in day order:
// each { key, month (YYYY-MM), dates: [YYYY-MM-DD,…] }.
TT.weekSegments = function (anchor) {
  /** @type {Map<string, import('./types.ts').WeekSegment>} */
  const byKey = new Map();
  for (const date of TT.weekDates(anchor)) {
    const key = TT.segmentKey(date);
    let seg = byKey.get(key);
    if (!seg) {
      seg = { key, month: date.slice(0, 7), dates: [] };
      byKey.set(key, seg);
    }
    seg.dates.push(date);
  }
  return [...byKey.values()];
};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
TT.fmtDayLong = (s) => {
  const d = TT.parseDate(s);
  return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()];
};
TT.fmtDayShort = (s) => {
  const d = TT.parseDate(s);
  return DAYS[d.getDay()].slice(0, 3) + ' ' + d.getDate() + ' ' + MON[d.getMonth()];
};
TT.fmtMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return MON[m - 1] + ' ' + y;
};

// billing
TT.roundBill = function (min, rounding) {
  const increment = Number(rounding);
  return !increment || min <= 0 ? min : Math.ceil(min / increment) * increment;
};
TT.projectOf = (state, code) => state.projects.find((project) => project.code === code) || null;
// SDD-002: the billable default an entry inherits from its PROJECT at birth.
// Billable unless the project says otherwise — no project, an unknown project and
// a project stored before this field existed all resolve to billable. Both sides
// derive from this (supersedes SB-011's task-level taskBillable).
TT.projectBillable = function (state, code) {
  const project = state.projects.find((candidate) => candidate.code === code);
  return project ? project.billable !== false : true;
};
// SDD-002: an entry owns its project code directly (copied at birth) — no task lookup.
TT.entryProjectCode = function (state, entry) {
  return entry.project ?? null;
};
// SB-088: the letters NFD cannot help with. Æ/Ø/Ð/Þ/ß carry no combining mark, so
// decomposition leaves them whole and the `[^a-z0-9]` sweep below then DELETES them —
// "Bærum" came out `b-rum` and "Sør-Norge" `s-r-norge`, a dropped letter rather than a
// transliterated one, in a catalog that is mostly Norwegian. Every other accented letter
// (å, é, ö, ú) is a base letter plus a combining mark, which NFD does split.
const TRANSLITERATE = /** @type {Record<string, string>} */ ({
  æ: 'ae',
  ø: 'o',
  ð: 'd',
  þ: 'th',
  ß: 'ss',
  Æ: 'AE',
  Ø: 'O',
  Ð: 'D',
  Þ: 'TH',
});
/**
 * ASCII-fold a name: transliterate the mark-less letters, then let NFD strip the marks
 * off the rest. Case is preserved, because the project-code rule wants upper and the slug
 * rule wants lower. This is the ONE place either of them learns about Norwegian.
 * @param {string} s
 */
const asciiFold = (s) =>
  s
    .replace(/[æøðþßÆØÐÞ]/g, (ch) => TRANSLITERATE[ch])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // å → a, é → e — the marks NFD split off
// SB-088: ONE slug rule. `makeClientId` (client/src/clientIds.ts) had to carry a second,
// transliterating copy of this because shared/core.js was held by another session when
// SB-067 landed; it now calls straight through here, passing '' as the fallback.
//
// This changes what NEW ids look like. It does NOT rename anything already stored, and
// nothing re-derives an id for an existing row — see the note on TT.projectCode.
// The two character caps a minted identifier holds to, named once so nothing hardcodes a
// number the de-collide rule also has to know (SB-111).
/** Client ids and task ids — what TT.slug emits. */
TT.ID_CAP = 24;
/** Project codes — what TT.projectCode emits: four letters, a dash, four letters. */
TT.CODE_CAP = 9;
/** @param {string} s @param {string} [fallback] what an unsluggable name becomes */
TT.slug = (s, fallback = 'task') =>
  asciiFold(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TT.ID_CAP)
    .replace(/-+$/g, '') || fallback; // the cap can land mid-dash
// ONE de-collision rule for every minted identifier — client ids, project codes, task ids
// (SB-111, ruled 2026-07-26).
//
// There were two conventions and they disagreed about both the spelling and the cap.
// `derivedClientId` counted `brygga`, `brygga-2`, `brygga-3`; `createProject` and `createTask`
// APPENDED a literal `2`, so a third collision read `code222` — unreadable, and unbounded. All
// three grew PAST their cap: `base + '-2'` is 26 characters against TT.slug's 24, and `code + '2'`
// is 10 against a project code's 9. A cap that the de-collide step is allowed to exceed is not a
// cap; the id is a visible join key in the markdown mirror and, under the vault backend, in an
// authoritative note, so its width is a promise to the reader.
//
// So the suffix fits INSIDE the cap: the BASE is truncated to make room (`-2`, `-3`, … `-10`),
// never appended past it. A truncation that lands on a dash drops it, the same way TT.slug does,
// so no id ever reads `foo--2`.
//
// NOT A MIGRATION. This is what a NEWLY minted id looks like. Nothing already stored is re-keyed:
// no client id, project code or task id is re-derived anywhere, and a code rename stays the
// deliberate, server-reconciled act of DC-005.
/**
 * @param {string} base the id the naming rule produced, already capped
 * @param {(id: string) => boolean} isTaken true while the candidate collides
 * @param {number} cap the maximum width the finished id may have
 * @returns {string} `base`, or the first free `base-N` that fits inside `cap`
 */
TT.uniqueId = (base, isTaken, cap) => {
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = '-' + n;
    const head = base.slice(0, Math.max(0, cap - suffix.length)).replace(/-+$/g, '');
    if (!isTaken(head + suffix)) return head + suffix;
  }
};
// The project code derived from a project's name at creation (`createProject`). Two
// words or more → first four letters of the first two, joined by a dash (FJEL-NETT);
// one word → its first eight. Lives here beside TT.slug because it is the same kind of
// rule — a persisted identifier derived from a name — and because in App.tsx it was
// reachable only from a React callback, i.e. only by the browser rung.
//
// SB-088: it had the same defect one function over, and worse — it never went through
// TT.slug at all, so `[^A-Z0-9 ]` deleted Æ/Ø/Å outright and "Bærum Bygg" became
// BRUM-BYGG. Folding first is the whole fix.
//
// NOT A MIGRATION: this is what a NEWLY created project is called. Every stored code
// keeps its exact bytes — no code, client id or task id is re-derived anywhere, and a
// rename stays the deliberate, server-reconciled act PLAN-006 made it (DC-005).
// SB-110: a HYPHEN SEPARATES WORDS, exactly like a space. It used to be deleted along with
// every other non-alphanumeric, so "Sør-Norge" collapsed into the single word SORNORGE while
// "Sør Norge" segmented to SOR-NORG — the same name, a different shape of answer, for a reason
// the user cannot see. Hyphenated proper nouns are ordinary in Norwegian company names
// (Sør-Norge, Nord-Trøndelag, Vest-Agder), so this is not an edge case in this catalog.
//
// The cap interaction, checked rather than assumed: a hyphenated name now takes the SAME path
// as its space-separated twin, so it inherits that path's shape — two words of at most four
// letters joined by a dash, at most 9 characters. That is one more than the single-word cap of
// 8 (Nord-Trøndelag: NORDTRON → NORD-TRON), and it is exactly what "Nord Trøndelag" already
// produced before this change. No new maximum is introduced, and nothing downstream constrains
// a code's length — `createProject` is the only caller.
TT.projectCode = (name) => {
  const words = asciiFold(name)
    .toUpperCase()
    .replace(/-/g, ' ')
    .replace(/[^A-Z0-9 ]/g, '')
    .trim()
    .split(/\s+/);
  const code =
    words.length > 1
      ? words
          .map((word) => word.slice(0, 4))
          .slice(0, 2)
          .join('-')
      : words[0].slice(0, 8);
  return code || 'PROJ';
};
TT.clientOf = (state, project) =>
  project && project.clientId ? state.clients.find((client) => client.id === project.clientId) || null : null;
TT.rateOf = function (state, code) {
  const project = TT.projectOf(state, code);
  if (!project) return 0;
  if (project.rate != null) return project.rate;
  const client = TT.clientOf(state, project);
  return client && client.rate != null ? client.rate : 0;
};
TT.billMinutes = function (state, entry) {
  if (!entry.billable) return 0;
  const project = TT.projectOf(state, TT.entryProjectCode(state, entry));
  const client = TT.clientOf(state, project);
  return TT.roundBill(TT.entryMinutes(entry), client ? client.rounding : 0);
};
TT.amount = (state, entry) => (TT.billMinutes(state, entry) / 60) * TT.rateOf(state, TT.entryProjectCode(state, entry));
// SDD-002 ruling 8: the frozen money for an entry whose (week∩month) segment is
// committed, or null. The snapshot is authored server-side at commit; these readers
// are the single source both the server team report and the admin invoice call so a
// rate renegotiation moves an uncommitted month but never a committed one.
TT.commitSnapshot = function (state, entry) {
  const commits = state.commits;
  if (!commits || !commits.length) return null;
  const key = TT.segmentKey(entry.date);
  const seg = commits.find((commit) => commit.key === key);
  if (!seg || !seg.snapshot) return null;
  return seg.snapshot[entry.id] || null;
};
// Prefer the frozen snapshot when the entry is committed; fall back to live billing.
TT.effectiveBillMinutes = function (state, entry) {
  const snap = TT.commitSnapshot(state, entry);
  return snap ? snap.billMin : TT.billMinutes(state, entry);
};
TT.effectiveAmount = function (state, entry) {
  const snap = TT.commitSnapshot(state, entry);
  return snap ? snap.amount : TT.amount(state, entry);
};
// SDD-002 ruling 5 (SB-025): a stored segment is LOCKED when an admin has approved it
// and not since released it. Approve clears releasedBy / Release clears approvedAt, so a
// present approvedAt is exactly 'approved-and-not-released'.
TT.segmentApproved = function (seg) {
  return !!(seg && seg.approvedAt);
};
// SDD-002 rulings 4/5: the per-segment review status of a month. For each (ISO week ∩
// this month) segment that HAS entries, in key order: { key, committed, approved }.
// Pure over a Catalog (its entries + commit ledger) so the review pills and the nav
// badge share one rollup. 'Month is good' is the derived monthGood below.
TT.monthSegments = function (state, month) {
  const commits = state.commits || [];
  const keys = new Set();
  for (const entry of state.entries) {
    if (!entry.date || entry.date.slice(0, 7) !== month) continue;
    keys.add(TT.segmentKey(entry.date));
  }
  return [...keys].sort().map((key) => {
    const seg = commits.find((commit) => commit.key === key);
    return { key, committed: !!seg, approved: TT.segmentApproved(seg) };
  });
};
// SDD-002 ruling 4: a month is 'good' when every segment that has entries is committed.
// A month with no entries is vacuously good.
TT.monthGood = function (state, month) {
  return TT.monthSegments(state, month).every((seg) => seg.committed);
};

const PALETTE = [
  'var(--accent)',
  'var(--blue)',
  'var(--green)',
  'var(--orange)',
  'var(--purple)',
  'var(--yellow)',
  'var(--gold)',
];
TT.projColor = function (state, code) {
  const i = state.projects.findIndex((project) => project.code === code);
  return i < 0 ? 'var(--text-3)' : PALETTE[i % PALETTE.length];
};

// ---- markdown format (v2 — SDD-002) ----
// v2 self-describes entries: each carries its own project + label (copied at birth),
// no longer a link to a template. A `format: 2` header marks it; parseMd still reads
// v1 files, migrating each entry's task id into its own label + project on read.
let _id = 1;
const nid = () => 'e' + _id++ + '-' + Date.now().toString(36);
TT.newId = nid;
/** @param {Entry} entry @param {ParsedTime | null} [parsed] */
function applyParsed(entry, parsed) {
  if (!parsed) return;
  if (parsed.kind === 'duration') entry.durMin = parsed.min;
  else {
    entry.start = parsed.start;
    entry.end = parsed.kind === 'range' ? parsed.end : null;
  }
}

// ---- cell escaping (SB-041) ----
// Without this, content that LOOKS like structure IS structure: a client named
// `Acme | Co` came back as `Acme`, and a note reading `refactored the [nb]` came back
// as `refactored the` with billable falsely flipped off. These primitives are shared: SB-055's
// vault block format calls them on its table cells (SB-045), and THERE no authoritative DB sits
// behind the file, so a corrupting round-trip is data loss rather than a recoverable rewrite.
// The v2 `|`-mirror below is not that file — it is written by the `team` shape's path
// (server/src/markdown.js) and always has the DB behind it. Getting these right matters for
// the mirror; it matters more for what SB-055 builds on top of them.
//
// Scheme: backslash escapes the following character, the same convention the vault's
// own table syntax uses (SB-045 measured that `\|` renders as a literal `|` inside an
// Obsidian table cell). Only three characters are ever emitted escaped:
//   `\`  — the escape character itself. A field containing a literal backslash MUST
//          double it, or `C:\path` would decode as `C:path` and, worse, a trailing
//          `\` would swallow the delimiter after it. This is the one byte change this
//          scheme imposes on pre-existing content; it is deliberate, not an oversight.
//   `|`  — the column delimiter.
//   `[`  — but ONLY when it opens a `[nb]`/`[ea]` token in the trailing run of a note,
//          which is the only position parseMd reads as a flag (see escapeMarkerTail).
// EMIT-WHEN-NEEDED: a field holding none of these serializes to exactly its own bytes,
// so every existing golden and TT.seedMd() stay byte-identical, and no `format: 3` bump
// was needed for that.
//
// KNOWN READ-PATH CAVEAT — SETTLED, do not "fix" (SB-069, ruled 2026-07-25): `format: 2`
// does not distinguish a mirror written before this change from one written after, and the
// marker is the only thing that could. In a PRE-change mirror a backslash is a literal, so
// `see C:\work` now reads back as `see C:work`. Ruled ACCEPT AS IS — an accepted one-way
// migration, and `decodeCell` stays UNCONDITIONAL. Measured at the time: zero backslashes
// across all four live mirrors, and zero in the vault's git history, so the affected
// population was empty; live mirrors also self-heal, the server rewriting them from the DB
// on the next PUT. A `format: 3` bump was the alternative and lost — it would rewrite the
// header line of all five goldens and TT.seedMd() to protect nothing. Note this rules on
// the v2 mirror ONLY; it sets no precedent for the vault block format, where there is no
// authoritative copy and the trade-off comes out differently.
//
// WHICH HALF OF THE CODEC IS PUBLIC, AND WHY (SB-071, ruled in PLAN-009 task 1).
// PLAN-008 exported an encode-shaped boundary. SB-055's vault parser reads the table BACK,
// so the READ half it genuinely needs is now public too:
//   • `TT.splitUnescaped` / `TT.splitCells` — EXPORTED. Parsing a vault row means splitting
//     on unescaped `|`, and a second hand-maintained copy of that rule is exactly the drift
//     PLAN-008 unified away. One implementation serves the v2 mirror and the vault table.
//   • `decodeNoteCell` — deliberately NOT exported. Its premise does not hold for the vault:
//     the trailing `[nb]`/`[ea]` flag run is the v2 mirror's convention, and SB-045 gave the
//     vault a dedicated `Bill` column instead. The vault Task cell's inverse pair is
//     `TT.encodeTaskCell` / `TT.decodeTaskCell` — already public, already symmetric, and a
//     note ending in `[nb]` round-trips through them untouched (no flag peel, no spurious
//     backslash). Exporting it would widen the public API for a consumer that does not exist.
// Do not re-ask this without a consumer in hand.
/** Escape a value for use as one `|`-delimited cell. @param {string} s @returns {string} */
TT.encodeCell = function (s) {
  s = s == null ? '' : String(s);
  return s.replace(/[\\|]/g, (c) => '\\' + c);
};
/** Reverse of encodeCell: `\X` → `X` for any X. @param {string} s @returns {string} */
TT.decodeCell = function (s) {
  s = s == null ? '' : String(s);
  if (s.indexOf('\\') < 0) return s; // the overwhelmingly common case — skip the scan
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[++i];
      continue;
    }
    out += s[i];
  }
  return out;
};
// Split on UNESCAPED occurrences of `delim` only, returning the pieces STILL escaped —
// callers read structure out of them (rule tokens, flag markers) and decode last, or
// `\[nb]` gets eaten. One implementation for every delimiter these formats use, so the
// escape rule cannot drift between them.
/** @param {string} s @param {string} delim @param {boolean} [trim] @returns {string[]} */
TT.splitUnescaped = function (s, delim, trim) {
  const out = [];
  let last = 0;
  for (let i = s.indexOf(delim); i >= 0; i = s.indexOf(delim, i + 1)) {
    if (isEscapedAt(s, i)) continue;
    out.push(s.slice(last, i));
    last = i + delim.length;
  }
  out.push(s.slice(last));
  return trim ? out.map((x) => x.trim()) : out;
};
/** Split a `|`-delimited row body into its cells. @param {string} s @returns {string[]} */
TT.splitCells = (s) => TT.splitUnescaped(s, '|', true);
// Is the character at `i` in `s` escaped? True when an ODD number of backslashes
// immediately precedes it (`\[` is escaped; `\\[` is a literal backslash then a live `[`).
/** @param {string} s @param {number} i @returns {boolean} */
function isEscapedAt(s, i) {
  let n = 0;
  while (--i >= 0 && s[i] === '\\') n++;
  return n % 2 === 1;
}
// A note's TRAILING run of `[nb]`/`[ea]` tokens is the flag zone — parseMd peels it off
// from the right. So a note whose own text ends there must have those `[` escaped, and
// only those: `see [1] for details` keeps its bracket, `done [ea]` does not.
/** @param {string} s already \-escaped for `\` and `|` @returns {string} */
function escapeMarkerTail(s) {
  let head = s,
    tail = '';
  for (;;) {
    const m = /\[(?:nb|ea)\]\s*$/.exec(head);
    if (!m || isEscapedAt(head, m.index)) break;
    tail = '\\' + head.slice(m.index) + tail;
    head = head.slice(0, m.index);
  }
  return head + tail;
}
TT.encodeNoteCell = function (/** @type {string} */ note) {
  return escapeMarkerTail(TT.encodeCell(note));
};
// Peel the trailing flag markers off a still-escaped note. Mirror of encodeNoteCell:
// an escaped `\[nb]` is content and STOPS the peel, an unescaped one is a flag.
/** @param {string} raw @returns {{ note: string, billable: boolean, editedByAdmin: boolean }} */
function decodeNoteCell(raw) {
  let note = raw,
    billable = true,
    editedByAdmin = false,
    m;
  while ((m = /\[(nb|ea)\]\s*$/.exec(note)) && !isEscapedAt(note, m.index)) {
    if (m[1] === 'nb') billable = false;
    else editedByAdmin = true;
    note = note.slice(0, m.index).replace(/\s+$/, '');
  }
  return { note: TT.decodeCell(note), billable, editedByAdmin };
}

// ---- vault `Task` cell codec (SB-045) ----
// SB-045 froze the vault's Task column as label on line 1 and `- note` on line 2, both
// inside ONE table cell: `label<br>- note`. Two consequences the codec has to own:
//   • `<br>` is a STRUCTURAL delimiter, so a note that mentions `<br>` has to escape it.
//   • `- ` is PRESENTATION, so it is stripped on decode and re-added on encode. Carry it
//     into the value and it accretes a hyphen per write cycle (`- - note`).
// The subtle case: a LABEL that itself begins with `- ` is otherwise indistinguishable
// from a note-only cell, so that one gets escaped too. A note beginning with `- ` needs
// no escape — decode strips exactly one prefix, so the second survives.
//
// This is only the codec. The vault table parser/serializer around it — heading anchors,
// header-row-as-schema, the totals row, the `revision: N` line — is SB-055.
const BR = '<br>';
/** @param {string} s @returns {string} */
const escapeBr = (s) => (s.indexOf(BR) < 0 ? s : s.split(BR).join('\\' + BR));
/** @param {string} s @returns {string} */
const stripNotePrefix = (s) => (s.startsWith('- ') ? s.slice(2) : s);
/**
 * Encode a label/note pair into one vault Task cell. Fields are escaped FIRST (so the
 * `|` layer composes), then joined with the structural `<br>`.
 * @param {{ label?: string, note?: string }} v @returns {string}
 */
TT.encodeTaskCell = function (v) {
  let label = escapeBr(TT.encodeCell(v.label || ''));
  const note = escapeBr(TT.encodeCell(v.note || ''));
  // a label starting with `- ` would decode as a note-only cell — escape the hyphen
  if (label.startsWith('- ')) label = '\\' + label;
  if (!note) return label;
  return label ? label + BR + '- ' + note : '- ' + note;
};
/**
 * Reverse of encodeTaskCell. A cell with no `<br>` is a label, UNLESS it opens with a
 * literal `- ` — that is the note-only shape (`- note`, deliberately no leading `<br>`).
 * No escape check is needed on that prefix: an escaped label is emitted as `\- …`, which
 * does not start with `- ` at all.
 * @param {string} cell @returns {{ label: string, note: string }}
 */
TT.decodeTaskCell = function (cell) {
  const parts = TT.splitUnescaped(cell == null ? '' : String(cell), BR);
  if (parts.length > 1) {
    // only the FIRST unescaped <br> is the delimiter; any further one is content a hand
    // edit left raw, and decodes to a literal <br> (re-escaped on the next encode)
    return {
      label: TT.decodeCell(parts[0]),
      note: TT.decodeCell(stripNotePrefix(parts.slice(1).join(BR))),
    };
  }
  const only = parts[0];
  if (only.startsWith('- ')) return { label: '', note: TT.decodeCell(stripNotePrefix(only)) };
  return { label: TT.decodeCell(only), note: '' };
};

// ---- vault `Mode` cell codec (SB-059) ----
// `Entry.tags` ⇄ one `Mode` cell. Built the same way encodeTaskCell is — escape the fields
// with TT.encodeCell FIRST, then escape this cell's own structural delimiter — because the
// alternative is a second, hand-maintained copy of the escape rule, which is the drift
// PLAN-008 unified away.
//
// THE DELIMITER IS THE SPACE, because that is how a human writes two tags in one cell
// (`#deep #admin`) and SB-045 froze the shape Terje already writes. So a tag containing a
// space has to escape it, exactly as a note mentioning `<br>` escapes that. Skipping this is
// SB-082/SB-070's failure mode one layer down: not a split ROW, but a split TAG — `#deep work`
// silently becoming two tags, and the next write emitting bytes Terje never typed.
//
// `<br>` NEEDS NO ESCAPE HERE, and must not get one. It is structural only in the Task cell;
// in a Mode cell it is ordinary content, and the row-level `|` escaping already keeps it from
// touching the table. Escaping it anyway would emit `\<br>` for a value that had no problem.
//
// ENCODE NORMALISES, DECODE IS FAITHFUL. Each tag is trimmed and the empties dropped on the
// way out, because a table cell is trimmed on the way in (vaultRowCells → splitCells) — an
// edge space could not survive the round-trip whatever we did, so it is removed at the one
// place that can do it losslessly instead of silently mangled at the other. Interior spaces
// are untouched.
const TAG_DELIM = ' ';
/** @param {string} s already \-escaped for `\` and `|` @returns {string} */
const escapeTagSpaces = (s) => (s.indexOf(TAG_DELIM) < 0 ? s : s.split(TAG_DELIM).join('\\' + TAG_DELIM));
/**
 * Encode tags into one vault `Mode` cell. No tags ⇒ the empty cell.
 * @param {string[] | null} [tags] @returns {string}
 */
TT.encodeTagsCell = function (tags) {
  if (!tags || !tags.length) return '';
  /** @type {string[]} */
  const out = [];
  for (const tag of tags) {
    const trimmed = String(tag == null ? '' : tag).trim();
    if (trimmed) out.push(escapeTagSpaces(TT.encodeCell(trimmed)));
  }
  return out.join(TAG_DELIM);
};
/**
 * Reverse of encodeTagsCell. Splits on UNESCAPED spaces only; runs of them collapse (an
 * empty piece is not a tag), so a hand-typed `#deep   #admin` reads as two tags and
 * converges on one space on the next write.
 * @param {string} cell @returns {string[]}
 */
TT.decodeTagsCell = function (cell) {
  /** @type {string[]} */
  const out = [];
  for (const part of TT.splitUnescaped(cell == null ? '' : String(cell), TAG_DELIM)) {
    if (part !== '') out.push(TT.decodeCell(part));
  }
  return out;
};

// ---- vault `Project` cell: the `[[Wikilink]]` fallback (SB-059) ----
// `Project.vaultNote` set ⇒ the cell renders `[[Lifelines Tycoon]]`; absent ⇒ the bare code
// (`LT-01`). The MODEL always holds the code — the wikilink is a rendering of it, produced on
// write and undone on read — so nothing downstream has to know which spelling a note used.
//
// It is a per-PROJECT field, not a column config: two projects in one block render
// differently, which a per-column switch cannot express.
//
// BOTH DIRECTIONS ARE OPT-IN, through the `projects` option. Without it TT has no catalog to
// resolve against, and the cell is carried verbatim — which is precisely the pre-SB-059
// behaviour, so every existing caller and golden is unmoved. A wikilink no project claims is
// also carried verbatim (a hand-written `[[Planning]]` for a project TT does not know is
// still Terje's bytes, and inventing a code for it would be a guess).
//
// The brackets are composed here and stripped here, so `Project.vaultNote` holds the note
// NAME. `encodeWikilink` / `readWikilink` below are THE composition — every site that writes
// or reads a `[[…]]` cell goes through them, in both the daily block and the catalog note.
//
// THE ORDER IS DELIBERATE AND IS THE WHOLE POINT OF SB-122 (ruled 2026-07-26). The brackets are
// STRUCTURE, exactly like the `|` that delimits the cell: they are added AFTER the note name is
// escaped, and read off BEFORE the inner text is decoded. So the write is
// `'[[' + encodeCell(note) + ']]'` and the read runs `WIKILINK_RE` on the STILL-ESCAPED cell.
//
// It was previously composed twice in OPPOSITE orders — the daily block bracketed first and
// escaped the brackets along with the name, the catalog escaped first and bracketed after. Both
// halves round-tripped, but only because `encodeCell` happens not to escape `[`; the two sites
// emitted the same bytes by coincidence, not by rule. Widening `encodeCell` — a change SB-041
// has already made once for other characters — would have split them silently, and a wikilink is
// a join key here, so a mangled one is a rate that resolves to 0, not a cosmetic defect.
// `tests/core.test.js` pins this by widening `encodeCell` to escape `[`/`]` and asserting both
// sites still agree; do not restore a second composition.
const WIKILINK_RE = /^\[\[(.+)\]\]$/;
/**
 * A note name as a finished, ESCAPED `[[…]]` cell. Escape first, bracket after.
 * @param {string} note @returns {string}
 */
const encodeWikilink = (note) => '[[' + TT.encodeCell(note) + ']]';
/**
 * The inverse: a still-escaped cell to the DECODED note name, or `null` when the cell is not a
 * wikilink at all. Brackets off first, decode after.
 * @param {string} cell still escaped @returns {string | null}
 */
function readWikilink(cell) {
  const m = WIKILINK_RE.exec(cell);
  return m ? TT.decodeCell(m[1]) : null;
}
/**
 * How a project code is written in a `Project` cell — the finished, ESCAPED cell.
 * @param {string} code @param {Project[]} [projects] @returns {string}
 */
function vaultProjectCell(code, projects) {
  const project = projects && projects.find((candidate) => candidate.code === code);
  return project && project.vaultNote ? encodeWikilink(project.vaultNote) : TT.encodeCell(code);
}
/**
 * The inverse: a still-escaped `Project` cell back to a project code. First match wins — two
 * projects claiming one note is a catalog the UI has to prevent, not something the parser
 * can arbitrate. A wikilink no project claims is carried verbatim (decoded), as is a bare code.
 * @param {string} cell still escaped @param {Project[]} [projects] @returns {string}
 */
function vaultProjectCode(cell, projects) {
  if (projects) {
    const note = readWikilink(cell);
    const project = note === null ? null : projects.find((candidate) => candidate.vaultNote === note);
    if (project) return project.code;
  }
  return TT.decodeCell(cell);
}

// ---- vault MERGED `Task` cell codec (SDD-004) ----
// SDD-004 folds `Project` into `Task`, joined by a colon: `LIFE:Game Design<br>- Card hand`.
// The merged cell is the project codec COMPOSED with the Task codec above, and `TT.encodeTaskCell`
// / `TT.decodeTaskCell` are untouched. That is deliberate and load-bearing: DD-014's losslessness
// argument for this cell is that both halves are ALREADY symmetric, so the composition is too.
// Reach into the task half and that argument has to be re-made from scratch.
//
// DELIMITER: the first unescaped `:`. Absent, the whole cell is a task and the entry has no
// project. Every `:` in the encoded task portion and in the project prefix is written `\:`, and
// the encoder inserts exactly ONE unescaped `:` as the joint. Same three-layer shape `<br>`
// already uses one level down (escape the fields FIRST, then this cell's own delimiter).
//
// WHY THE ESCAPE IS NOT OPTIONAL. `TT.encodeCell` does not escape `:`. Without the rule the label
// `Meeting: standup` decodes as project `Meeting`, label `standup` — an entry filed against a
// project that does not exist. `core.js:936` names this same class one layer down (`#deep work`
// silently becoming two tags). No new primitive is needed for it: `TT.splitUnescaped` already
// skips escaped delimiters and `TT.decodeCell` already unescapes `\X → X` for any X.
//
// THE BRACKETS HOLD THE CODE HERE, NOT THE NOTE NAME — the one place this differs from the legacy
// `Project` column above (`vaultProjectCell`, which brackets `Project.vaultNote`). A merged cell
// with a linked project writes `[[LIFE]]`, and `LIFE` resolves through an ALIAS in the project
// note. SDD-004 measured why: the alternative that keeps both the link and the note name is
// `[[Lifelines\|LIFE]]`, which is 82 characters against today's 81 — wider than the two columns it
// replaces, so it defeats the change — and `\|` would put DD-023's padding math on unverified
// ground. The cost is that a missing alias shows as an unresolved link in Obsidian, which TT
// cannot fix because it does not own that note's frontmatter (GAP-001).
//
// CONSEQUENCE WORTH NAMING: decode needs NO catalog. The code is in the brackets, so reading a
// merged cell resolves nothing — unlike `vaultProjectCode`, which needs `projects` to map a note
// name back to a code.
const MERGE_DELIM = ':';
/** @param {string} s already \-escaped by the layers below @returns {string} */
const escapeMergeDelim = (s) => (s.indexOf(MERGE_DELIM) < 0 ? s : s.split(MERGE_DELIM).join('\\' + MERGE_DELIM));
// THE INLINE-ALIAS WIKILINK, `[[Lifelines\|LIFE]]` — Terje's ruling on 2026-08-03, overriding
// SDD-004's `[[CODE]]`. Obsidian RENDERS this as `LIFE`, so the reader sees the code and only the
// source is longer. The source width was one of SDD-004's two objections and it is the weaker one:
// nobody reads the raw bytes of a table they are looking at in Obsidian.
//
// SDD-004's OTHER objection was real and is now MEASURED rather than assumed. It said `\|` puts
// DD-023's padding math on unverified ground, because `vaultAlignedTable` counts `\|` as two code
// units and nobody knew what Obsidian counts when it re-aligns. Terje's own vault answered it:
// `Calendar/Daily/2026-02-09.md` is an Obsidian-aligned table whose Project column holds
// `[[Projects/Lifelines/Lifelines\|Lifelines]]`, and Obsidian padded that column to 43 — the raw
// source length, `\|` counted as two, every row exactly 105 characters. TT computes the same 43.
// The two agree, so there is no re-pad ping-pong. (And even had they disagreed, DD-023 half 2
// makes the digest compare NORMALISED text, so a padding difference cannot quarantine a day —
// it could only have churned bytes.)
//
// TWO PROBLEMS DISSOLVE WITH IT. The link resolves by NOTE NAME, so the project note needs no
// `aliases` frontmatter — GAP-001's unresolved link cannot happen. And when Obsidian rewrites the
// target on a rename it keeps the display text, so the code survives a rename, which `[[CODE]]`
// could not.
//
// THE SEPARATOR IS WRITTEN `\|` BECAUSE IT IS INSIDE ONE CELL. `|` is the row delimiter, so an
// unescaped one would split the row. It is structure at the wikilink layer and escaped at the cell
// layer, which is why it is composed AFTER both fields go through `encodeCell` (SB-122's order),
// and why the reader below finds it BEFORE anything is decoded.
const ALIAS_SEP = '\\|';
/**
 * A note name and a code as one finished, ESCAPED `[[note\|code]]` cell. Escape first, compose after.
 * @param {string} note @param {string} code @returns {string}
 */
const encodeAliasedWikilink = (note, code) => '[[' + TT.encodeCell(note) + ALIAS_SEP + TT.encodeCell(code) + ']]';
/**
 * A project prefix — `[[note\|code]]`, `[[code]]` or a bare code — back to the CODE. Reads structure
 * off the STILL-ESCAPED bytes, then decodes, which is the one order this file allows (SB-122).
 *
 * The alias separator is an ESCAPED `|`, and it is found with `isEscapedAt` rather than `indexOf`.
 * BE HONEST ABOUT WHY: the two cannot disagree here, because an UNESCAPED `|` would have split the
 * row back in `vaultRowCells` and never reached this function as one cell. So this is not a bug
 * fix, it is using the file's own primitive for "is this delimiter live" instead of a second rule
 * that happens to agree. Do not add a test claiming it catches something — it does not, and a
 * mutation to `indexOf` stays green on purpose.
 *
 * A prefix with no separator is the `[[CODE]]` form SDD-004 originally specified — still read, so
 * anything written between b6b8a22 and this ruling keeps parsing.
 * @param {string} raw still escaped @returns {string}
 */
function readProjectPrefix(raw) {
  const m = WIKILINK_RE.exec(raw);
  if (!m) return TT.decodeCell(raw);
  const inner = m[1];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '|' && isEscapedAt(inner, i)) return TT.decodeCell(inner.slice(i + 1));
  }
  return TT.decodeCell(inner);
}
/**
 * Encode a project/label/note triple into ONE merged vault `Task` cell. `projects` is the same
 * opt-in catalog the `Project` column takes: absent, or a project it does not claim, writes the
 * bare code — which is exactly what a note carries when TT has no catalog to resolve against.
 * @param {{ project?: string | null, label?: string, note?: string }} v
 * @param {Project[]} [projects]
 * @returns {string}
 */
TT.encodeMergedTaskCell = function (v, projects) {
  const task = escapeMergeDelim(TT.encodeTaskCell({ label: v.label, note: v.note }));
  const code = v.project || '';
  // No project ⇒ the joint is not written. NOT byte-identical to `encodeTaskCell` alone, though:
  // the colon escape runs unconditionally and has to, because a cell is read back without knowing
  // what wrote it — an unescaped colon in a project-less cell would decode as a project on the next
  // read. THE COST, named because this file names its costs: every colon a person types into a
  // four-column Task cell comes back as a literal `\:` in the note. `\|` and `\<br>` are rare in
  // real text; a colon in a label is not. SB-175 is the gate that judges whether that is tolerable.
  if (!code) return task;
  const project = projects && projects.find((candidate) => candidate.code === code);
  let prefix;
  if (project && project.vaultNote) {
    prefix = encodeAliasedWikilink(project.vaultNote, code);
  } else {
    // A BARE CODE THAT ALREADY LOOKS LIKE A LINK GETS ESCAPED, the same way a label beginning
    // `- ` does one layer down. Decode reads `[[…]]` as structure and hands back the inner text,
    // so an unescaped `[[Home]]` here would come back as the code `Home` and the next write would
    // emit different bytes. `readWikilink` runs on the STILL-ESCAPED cell (SB-122), so one
    // backslash is enough to stop the match, and `decodeCell` takes it off again.
    prefix = TT.encodeCell(code);
    if (WIKILINK_RE.test(prefix)) prefix = '\\' + prefix;
  }
  return escapeMergeDelim(prefix) + MERGE_DELIM + task;
};
/**
 * Reverse of encodeMergedTaskCell. Only the FIRST unescaped `:` is the delimiter; any further one
 * is content a hand edit left raw, and is carried into the task portion — the same reading
 * `decodeTaskCell` gives a second raw `<br>`. An EMPTY prefix (a stray leading `:`) means no
 * project was written, so there is none.
 * @param {string} cell @returns {{ project: string | null, label: string, note: string }}
 */
TT.decodeMergedTaskCell = function (cell) {
  const parts = TT.splitUnescaped(cell == null ? '' : String(cell), MERGE_DELIM);
  if (parts.length < 2) return { project: null, ...TT.decodeTaskCell(parts[0]) };
  const raw = parts[0];
  // the prefix is read as STRUCTURE before it is decoded (SB-122's order): the brackets and the
  // `\|` alias separator are peeled off the still-escaped bytes, and only the code is decoded
  const project = raw === '' ? null : readProjectPrefix(raw);
  return { project, ...TT.decodeTaskCell(parts.slice(1).join(MERGE_DELIM)) };
};

// ---- vault block region (SB-055) ----
// This is the thing standing between a malformed daily note and TT overwriting Terje's
// Intentions, Habits, Captures and Reflection. It locates the block or REFUSES; it never
// throws, and it never hands back a region it is unsure of. Everything downstream — the
// parser (parseVaultBlock) and the writer (writeVaultBlock) — goes through it first.
//
// TWO ANCHORS, both mandatory (SB-045 final ruling):
//   • TOP: a `## <heading>` line. The name is `opts.heading`, defaulting to `Time Log`,
//     and is NEVER baked into a regex — SB-045 consequence 1 puts it in settings, and
//     `Settings` has no `vaultPaths` field yet, so SB-056/SB-058 must be able to feed it
//     in without touching this function. Matched at `##` level on the trimmed heading TEXT.
//   • BOTTOM: a line that is EXACTLY the inline-code span `` `revision: N` `` — the
//     backticks are literal syntax (SB-045's correction). A bare `revision: 8`, a
//     `revision:8` with no space, a non-numeric N and an indented copy all fail to match.
//
// THE HARD STOP. The forward scan from the heading stops at the next ATX heading line of
// ANY level (`#`…`######`). SB-045 names `##`; stopping at `#` too is strictly safer and
// costs nothing (an H1 is a note title, never inside a Time Log section). A revision line
// found only PAST that stop is not this block's anchor — the block quarantines rather than
// letting a missing bottom anchor run a write into `## Captures`.
//
// CODE FENCES. Lines inside a ``` / ~~~ fence are inert: they can neither be an anchor nor
// the hard stop. Without this a fenced example of the block format would be read as the
// real thing — and a fenced revision line is the dangerous direction, since it would name
// a bottom anchor in the middle of prose.
//
// SHAPE OF THE REGION. Between the anchors TT owns everything, so the shape is pinned
// tightly: the first non-blank line after the heading MUST be the table header row, the
// next line MUST be the `|---|` delimiter row, data rows run contiguously after it, and
// between the table and the revision line only blank lines are allowed. Anything else is a
// hand edit TT cannot account for, and it quarantines instead of splicing over it.
//
// ADOPTION (DD-012, ruled by Terje in SB-089). The locator above describes a note that ALREADY
// has both anchors. A daily note made by hand — or on the phone, or before the Templater
// template existed — has the heading and no `revision:` line, and before DD-012 that note was
// permanently unwritable: it quarantined forever while looking perfectly fine to a human.
// `vaultAdoptionCandidate` below is the one path that creates a bottom anchor, and it is
// deliberately NOT in this function: a located region's fields are LINE OFFSETS, and handing
// back offsets into a string the caller does not have is how a splice eats the wrong lines.
// `locateVaultBlock` therefore keeps answering exactly one question — "is there a block here" —
// and `parseVaultBlock` / `writeVaultBlock` run adoption first, on the note, before locating.
const VAULT_HEADING = 'Time Log';
// THE PAYLOAD DIGEST (DD-009, ruled by Terje in SB-078). The bottom anchor carries a short
// digest of the table payload — `` `revision: 8 · a3f1` `` — because `revision` alone is
// structurally incapable of detecting the corruption SB-051 measured on the real vault:
// Obsidian silently diff-merges an external write into a dirty open buffer, keeping TT's
// anchor line and the buffer's rows. The counter is the field that survives intact, so only a
// value derived FROM THE PAYLOAD can notice. On-note rather than in TT's index (DD-009's
// deciding argument): an on-note digest needs no surviving state, so any TT, on any machine,
// after any crash or index rebuild, verifies a block against itself.
//
// ONE matcher and ONE emitter, as before — this regex and `vaultRevisionLine`. It accepts BOTH
// shapes: the digest group is optional because DD-009 consequence 2 requires a digest-less line
// to PARSE and be reported UNVERIFIED, never quarantined. Getting that backwards makes every
// pre-cutover and hand-made block unreadable. Quarantine fires only on a digest that is present
// and WRONG.
//
// Strict lowercase hex, exactly 4, separator ` · ` (U+00B7). One canonical spelling, the way
// DD-010 keys the Task cell on the exact string `<br>`: TT is the only writer of this token, so
// a variant spelling is a hand edit, and a refusal is the honest answer rather than leniency
// that would let a near-miss read as verified. Near-misses (`· `, non-hex, no separator) fail
// the whole match, which is the safe direction — the line stops being an anchor at all.
const REVISION_RE = /^`revision: (\d+)(?: · ([0-9a-f]{4}))?`$/;
// …and the price of that strictness, paid in the diagnosis rather than in leniency (SB-090).
// A near-miss fails the WHOLE match, so before this the locator reported `no-revision` — "the
// bottom anchor is missing" — about a line the human is looking straight at. Same complaint
// SB-084 fixed for CRLF, different cause: there a stray `\r` explained the whole file, here a bad
// digest explains one line. The refusal does not move (SB-083: TT refuses, it does not repair a
// token it cannot read); only the reason does, so this can never write a byte.
//
// WHAT COUNTS AS ANCHOR-SHAPED, and why it is drawn exactly here. The span must OPEN with the
// canonical `` `revision: <digits> `` and CLOSE at end of line — that is the whole test. Every
// line inside it is one TT itself could have written and then had damaged: an empty digest, a
// digest of the wrong length, non-hex, uppercase, the separator missing or misspelt. It is not
// widened to the SB-045 near-misses (`revision: 8` unbackticked, ``revision: 8``, indented, wrong
// case, trailing prose, `revision: eight`), because those are lines TT cannot distinguish from
// prose a human typed, and claiming "your revision line is malformed" about someone's sentence is
// the same class of lie in the other direction. Those keep `no-revision`.
const MALFORMED_REVISION_RE = /^`revision: \d+[^`]*`$/;
/**
 * The digest over a block's table payload. FNV-1a/32 XOR-folded to 16 bits, 4 lowercase hex.
 *
 * NOT `node:crypto` (DD-009 consequence 3): this file is imported by the browser client
 * (`client/src/i18n.ts:3`) and has zero imports today — a Node import here breaks the client
 * build. A cryptographic hash is not what this needs anyway; the adversary is a text-editor
 * merge, not a forger. 16 bits leaves a ~1/65536 chance a merge slips through, which is the
 * cost DD-009 accepted for a 4-char token in the line Terje reads daily.
 *
 * Each UTF-16 code unit is folded as two bytes rather than masked to one. The payload really
 * does carry non-ASCII — `→`, `✓`, wikilinks, Norwegian labels — and `charCodeAt(i) & 0xff`
 * would collapse `→` (U+2192) and U+0092 to the same input. No `TextEncoder`, to keep this
 * function free of even ambient globals.
 *
 * DO NOT REUSE THIS FOR DD-008's ENTRY KEY — and note that the REASON CHANGED under DD-023.
 * The reason this sign used to give was that this digest is over the RAW LINE BYTES, "precisely
 * so that any byte-level change — including one that parses back to the same values — is
 * caught". SB-165 made that false on purpose: `vaultPayloadDigest` now normalises a table line's
 * framing whitespace before hashing, so intra-cell padding is exactly a byte-level change that
 * parses back to the same values and is deliberately NOT caught. A sign arguing from a withdrawn
 * premise reads as superstition and gets deleted by the next person who checks it, so here are
 * the two reasons that survive. Neither is a refinement of the other:
 *
 *   • DIFFERENT SUBJECT. This covers the WHOLE payload — header row, delimiter row, every data
 *     row, the totals row. `TT.entryMatchKey` covers ONE row's parsed fields. A block digest
 *     cannot answer "is this the same row"; a row key cannot see an added row, a removed row, a
 *     reordered header or a rewritten totals row. Neither does the other's job at ANY level of
 *     normalisation, so no amount of normalising here turns this into that.
 *   • DIFFERENT TOLERANCE. Even normalised, this still sees three things `entryMatchKey` drops
 *     BY DESIGN: the emitted time separator (it keys minutes-since-midnight, so flipping
 *     `vaultTimeSeparator` re-keys nothing — SB-063), escaping (DD-008 rule 1), and leading or
 *     trailing whitespace in `label` and `note`, which it trims on both sides. So
 *     block-digest-equal does not imply row-keys-equal, and row-keys-equal does not imply
 *     block-digest-equal. Two questions, two answers, still.
 *
 * DD-008 rule 10 leaves the entry-key hash to phase 3 (SB-167) to choose; this is not it, and
 * `TT.normaliseVaultPayloadLine` is not it either — being exported is not an argument.
 * @param {string} payload @returns {string}
 */
function vaultDigest(payload) {
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193);
    h = Math.imul(h ^ (c >>> 8), 0x01000193);
  }
  return (((h >>> 16) ^ h) & 0xffff).toString(16).padStart(4, '0');
}
// The payload the digest covers, per DD-009 consequence 1: header row + delimiter row + data
// rows (the totals row is the last of them). NOT the heading, NOT the blank lines, NOT the
// revision line itself — a digest that covered its own line could never be written.
//
// Takes the payload LINES, not a region and offsets: the writer knows them as the tail of the
// array it is building and the reader knows them as three named offsets into the note, and
// neither should have to fake the other's shape. What they share — the set of lines and the
// separator between them — is exactly what this function owns, so emit and verify cannot drift
// into two definitions that merely agree today.
//
// THE NORMALISATION LIVES IN HERE, NOT AT THE CALL SITES (DD-023 half 2, SB-165). The digest has
// three consumers — read (`parseAnchoredBlock`), write (`serializeVaultBlock` and
// `serializeVaultCatalogSection`) and the index (`server/src/vault-arbitrate.js`
// `describeVaultFile`) — and all three must agree about what the hash is taken over. Normalise at
// the WRITE sites only and TT writes an aligned block whose digest was taken over the compact
// form, the reader hashes the aligned bytes, they disagree, and every note TT writes quarantines
// on its own next read: the exact failure DD-023 exists to prevent, arriving from the fix. Inside
// the function that state is unreachable rather than merely avoided.
//
// `normaliseVaultPayloadLine` is defined next to `vaultRow`, the canonical emitter it re-emits
// through — see the ruling there for why the compact form is the normalisation TARGET and what
// that buys (every digest already sitting in a note re-hashes to itself; nothing to migrate).
/** @param {string[]} payloadLines @returns {string} */
const vaultPayloadDigest = (payloadLines) => vaultDigest(payloadLines.map(normaliseVaultPayloadLine).join('\n'));
// Exposed because the digest is part of the BLOCK FORMAT CONTRACT, not an implementation detail
// of one function: SB-057's index records a payload hash per path for the `file rev < index rev`
// split, and it must be the same hash the anchor carries rather than a second one that can drift.
// Takes payload lines (see `vaultPayloadDigest` above) — not a note, not a region.
TT.vaultPayloadDigest = vaultPayloadDigest;
/**
 * Unicode-normalise for comparison. macOS hands out NFD strings (a filename-derived setting,
 * a paste), and an NFD `Tidsløggen` is not `===` its NFC twin — the block would quarantine as
 * 'no-heading' for a heading sitting right there.
 * @param {string} s @returns {string}
 */
const nfc = (s) => (s.normalize ? s.normalize('NFC') : s);
/**
 * Is this line the `## <heading>` top anchor? One matcher, used by the scan and the CRLF
 * diagnosis, so the two cannot disagree about what an anchor is.
 * @param {string} line @param {string} heading already trimmed + NFC @returns {boolean}
 */
function isHeadingAnchor(line, heading) {
  const m = /^##[ \t]+(.*)$/.exec(line);
  return !!m && nfc(m[1].trim()) === heading;
}
/**
 * Every way TT can refuse a vault BLOCK — the vocabulary itself, as a runtime value.
 *
 * SB-109 MOVED THE VOCABULARY HERE FROM THE TYPE. `VaultBlockQuarantineReason` in
 * shared/types.ts is now DERIVED from this array (`(typeof …)[number]`), not restated beside
 * it, so the type and the list cannot disagree by construction — and the completeness guard in
 * tests/roundtrip.test.js imports this array instead of scraping the union out of a `.ts` file
 * with a regex. That scrape was truncated by any semicolon inside a doc comment and inflated by
 * any reason name quoted inside one; it reported a wrong count confidently rather than a parse
 * failure, and it cost SB-090 real time. Prose cannot lie to an import.
 *
 * Enumerated rather than left as `string` so SB-057's boot scan gets a compiler check when it
 * switches on these — a typo'd reason is otherwise silent.
 *
 * Ordered by the stage that produces the refusal: locator, parser, writer.
 *
 * NOT `VAULT_QUARANTINE_REASONS` further up this file — that one is reason → human sentence,
 * is deliberately `Record<string, string>` so it can also carry the arbitration verdicts, and
 * falls back rather than failing on a code it does not know. This is the VOCABULARY: the block
 * half of it, exactly, and the thing the type is made of.
 *
 * DOCUMENT THE MEMBERS FREELY. The comments below deliberately contain semicolons and
 * neighbouring reason names in single quotes — the two shapes of prose that used to break the
 * old scrape — precisely so that the coverage guard's indifference to them is standing evidence
 * and not a claim. Nobody should ever again have to reword a comment to satisfy a test.
 */
export const VAULT_BLOCK_QUARANTINE_REASONS = /** @type {const} */ ([
  // --- locator: the block cannot be bounded (the two anchors, the `##` hard stop, the region) ---
  'no-heading',
  'crlf-line-endings',
  'multiple-headings',
  'no-revision',
  // The bottom anchor is THERE — the note carries `revision: N …` inside the block — but TT
  // cannot read it, because the digest half is malformed: empty, the wrong length, non-hex,
  // uppercase, or separated by something other than ` · ` (SB-090). Distinct from 'no-revision'
  // because that one says "the line is missing" about a line the human is looking straight at,
  // which is the same lie SB-084 fixed for CRLF with a different cause. Distinct from
  // 'digest-mismatch' too — there the token is well-formed and describes different bytes; here
  // the token is not a token. TT refuses either way and repairs neither (SB-083), it just says
  // which of the two it is. NOT produced for lines that merely resemble the anchor without
  // carrying its inline-code span. See `MALFORMED_REVISION_RE` below.
  'malformed-revision',
  'revision-past-next-heading',
  'multiple-revisions',
  'no-table',
  'unexpected-content-in-block',
  // The bottom anchor's payload digest is present and does NOT match the table it labels —
  // DD-009. This is the one reason that means "the block is structurally fine and semantically
  // wrong": Obsidian's diff-merge (SB-051) keeps TT's anchor line and the buffer's rows, so
  // every other check passes. Never fires on a digest-less block, which is unverified, not
  // wrong; contrast 'no-revision', which is about an anchor that is not there at all.
  'digest-mismatch',
  // --- parser: the schema or a row cannot be read ---
  'unknown-header',
  'duplicate-header',
  'row-cell-count',
  'unparseable-time',
  'bad-bill-cell',
  // --- writer: what TT would emit is not readable back ---
  'write-would-corrupt',
]);
/**
 * @param {import('./types.ts').VaultQuarantineReason} reason
 * @returns {{ quarantine: true, reason: import('./types.ts').VaultQuarantineReason }}
 */
const vaultQuarantine = (reason) => ({ quarantine: true, reason });
/** @param {string} line @returns {boolean} */
const isTableRow = (line) => line.trim().startsWith('|');
/**
 * `|---|---|` (alignment colons allowed) — the row that makes the line above it a header.
 * @param {string} line @returns {boolean}
 */
const isDelimiterRow = (line) => /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line);
/**
 * Split a `| a | b |` table line into its trimmed, STILL-ESCAPED cells. The outer pipes are
 * table syntax, not delimiters; an escaped trailing `\|` is content and stays.
 * @param {string} line @returns {string[]}
 */
function vaultRowCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !isEscapedAt(s, s.length - 1)) s = s.slice(0, -1);
  return TT.splitCells(s);
}
// The generated totals row (SB-045: always present, never round-tripped as an entry).
//
// DETECTION RULE, pinned: it is the LAST table row of the block, its cell count matches the
// header, and EVERY non-empty cell is a totals cell — `**8.7h**` or `**5.1h billable**`.
// Detection and emission share this one regex, which is what makes them a single decision
// rather than two that merely happen to agree.
//
// An earlier version tested only "first cell is bold", justified by "an entry's Time cell is
// never bold". That justification silently assumed Time is column 0, which the vocabulary
// rule (any subset, any ORDER) does not guarantee — under a `| Task | Time |` header a row
// whose LABEL was bolded by hand was read as the totals row and dropped, and the block was
// then rewritten without it. An hour vanished from the note with no verdict, which is the
// exact failure row-level quarantine exists to prevent. Requiring the full generated shape
// means an ambiguous last row is no longer guessed: it falls through to the entry path and
// either parses as the entry it is, or quarantines.
const TOTALS_CELL_RE = /^\*\*\d+(?:\.\d+)?h(?: billable)?\*\*$/;
/** @param {string} line @param {number} cols @returns {boolean} */
function isTotalsRow(line, cols) {
  const cells = vaultRowCells(line);
  if (cells.length !== cols) return false;
  let seen = 0;
  for (const cell of cells) {
    if (cell === '') continue;
    if (!TOTALS_CELL_RE.test(cell)) return false;
    seen++;
  }
  return seen > 0; // an all-blank last row is a (degenerate) entry, not the totals row
}
/**
 * Which lines are inside a fenced code block. A fence opens on a run of three or more
 * backticks or tildes at the start of a line (up to 3 spaces of indent, the CommonMark
 * allowance) and closes only on a run of the SAME character, at least as long, with nothing
 * after it — also CommonMark. Matching the character matters: a documentation example fenced
 * with backticks may legitimately contain a tilde run, and treating that as the close would
 * end the fence early and expose the rest of the example. The note most likely to hold a
 * fenced copy of the block format is the note documenting the block format, so a located
 * region inside a code fence is a write into someone's documentation.
 *
 * The fence lines themselves count as inert, so a fence opener can never be an anchor.
 * NOTE: no literal fence marker appears in this comment — TypeScript parses JSDoc as
 * markdown, and an unterminated one swallows the tags below it (that is a real bug this
 * file has already had once).
 * @param {string[]} lines @returns {boolean[]}
 */
function markFences(lines) {
  const out = new Array(lines.length).fill(false);
  /** @type {{ char: string, len: number } | null} */
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (m && !open) {
      // an opener may carry an info string; a closer may not
      out[i] = true;
      open = { char: m[1][0], len: m[1].length };
      continue;
    }
    if (m && open && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === '') {
      out[i] = true;
      open = null;
      continue;
    }
    out[i] = !!open;
  }
  return out;
}
/**
 * The region bounds: the single anchor heading, and the hard stop that ends its region.
 *
 * ONE definition, shared by the locator and by adoption (DD-012). Adoption must never consider
 * a wider region than the locator would — that is the whole safety argument for letting it
 * insert an anchor — and two copies of this loop is exactly how that stops being true.
 *
 * @param {string[]} lines @param {boolean[]} fenced @param {string} heading already trimmed + NFC
 * @returns {{ count: number, start: number, stop: number }} `count` is how many unfenced anchor
 *   headings the note carries; `start` (the heading line) and `stop` (the next ATX heading of
 *   any level, or `lines.length`) are meaningful ONLY when it is exactly 1.
 */
function vaultAnchorScan(lines, fenced, heading) {
  let count = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || !isHeadingAnchor(lines[i], heading)) continue;
    if (!count) start = i;
    count++;
  }
  if (count !== 1) return { count, start: -1, stop: -1 };
  let stop = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (fenced[i]) continue;
    if (/^#{1,6}[ \t]/.test(lines[i])) {
      stop = i;
      break;
    }
  }
  return { count, start, stop };
}
/**
 * Locate the vault block in a note, or refuse. Never throws.
 * @param {string} md @param {{ heading?: string }} [opts]
 * @returns {import('./types.ts').VaultBlockLocation}
 */
TT.locateVaultBlock = function (md, opts) {
  const heading = nfc(((opts && opts.heading) || VAULT_HEADING).trim());
  const lines = String(md == null ? '' : md).split('\n');
  const fenced = markFences(lines);
  // The CRLF signal, computed ONCE for every anchor-shaped refusal below (SB-084). A `\r\n` note
  // leaves a `\r` on every line, and JS `.`/`$` do not cross it, so an anchor match fails on a
  // note that plainly HAS the anchor — for the heading, and equally for the revision line, whose
  // `no-revision` reads as "it isn't there" about a line a human can see on screen. Refusing is
  // the safe direction and stays the behaviour (TT does not rewrite line endings it did not
  // author, SB-083); what changes here is only which reason is reported, so this can never write
  // a byte. `endsWith('\r')` is deliberately the test rather than "contains a CR": a lone CR
  // mid-line is not the CRLF signature and must not take the blame for a genuinely absent anchor.
  // One signal, not one probe per branch — two probes that can disagree about what CRLF means is
  // the bug class PLAN-009's review unified in the totals-row detection.
  const crlf = lines.some((line) => line.endsWith('\r'));

  // 1. the top anchor — the heading TEXT compared exactly, never interpolated into a regex —
  //    and 2. the hard stop, the next heading of any level, which ends the region full stop
  const { count, start, stop } = vaultAnchorScan(lines, fenced, heading);
  // diagnose CRLF rather than blaming the heading — 'no-heading' would send a human looking in
  // the wrong place forever
  if (!count) return vaultQuarantine(crlf ? 'crlf-line-endings' : 'no-heading');
  // two blocks with one name: nothing can say which is the day's, so neither is writable. This
  // one does NOT defer to `crlf` — it found MORE than it expected, which a `\r` cannot explain,
  // so the specific reason is the useful one (same for 'multiple-revisions' below).
  if (count > 1) return vaultQuarantine('multiple-headings');

  // 3. the bottom anchor, which must sit BEFORE the hard stop
  /** @type {{ line: number, revision: number, digest: string | null }[]} */
  const revLines = [];
  for (let i = start + 1; i < stop; i++) {
    const m = fenced[i] ? null : REVISION_RE.exec(lines[i]);
    if (m) revLines.push({ line: i, revision: +m[1], digest: m[2] || null });
  }
  if (!revLines.length) {
    // CRLF FIRST, structurally rather than by repetition (SB-084's signal, SB-090's ordering): a
    // stray `\r` explains the whole file and every anchor in it, a bad digest explains one line,
    // so the file-wide diagnosis outranks the line-local one. Hoisted out of the two exits below,
    // which both spelled `crlf ? 'crlf-line-endings' : …` — identical behaviour, and now the
    // malformed probe added underneath cannot quietly overtake it on a note whose `\r` happens to
    // sit on some OTHER line than the anchor.
    if (crlf) return vaultQuarantine('crlf-line-endings');
    // name the dangerous case precisely: the anchor exists, but only in someone else's section.
    // This stays AHEAD of the malformed probe: it reports a hazard (a write that could run into
    // Terje's own section), the malformed probe reports a typo, and the hazard is the one a human
    // needs to hear first.
    for (let i = stop; i < lines.length; i++) {
      if (!fenced[i] && REVISION_RE.test(lines[i])) return vaultQuarantine('revision-past-next-heading');
    }
    // the anchor is right there and TT cannot read it — SB-090. Only inside the region: a
    // malformed line past the hard stop is not this block's anchor and never was.
    for (let i = start + 1; i < stop; i++) {
      if (!fenced[i] && MALFORMED_REVISION_RE.test(lines[i])) return vaultQuarantine('malformed-revision');
    }
    return vaultQuarantine('no-revision');
  }
  if (revLines.length > 1) return vaultQuarantine('multiple-revisions'); // found MORE — not CRLF's doing
  const { line: revisionLine, revision, digest } = revLines[0];

  // 4. the table: header row, delimiter row, then contiguous data rows
  let headerLine = -1;
  for (let i = start + 1; i < revisionLine; i++) {
    if (lines[i].trim() === '') continue;
    headerLine = isTableRow(lines[i]) ? i : -1;
    break;
  }
  const separatorLine = headerLine + 1;
  if (headerLine < 0 || separatorLine >= revisionLine || !isDelimiterRow(lines[separatorLine])) {
    return vaultQuarantine(crlf ? 'crlf-line-endings' : 'no-table');
  }
  /** @type {number[]} */
  const rowLines = [];
  let i = separatorLine + 1;
  for (; i < revisionLine && isTableRow(lines[i]); i++) rowLines.push(i);
  for (let j = i; j < revisionLine; j++) {
    if (lines[j].trim() !== '') return vaultQuarantine('unexpected-content-in-block');
  }

  // 5. the payload digest (DD-009). Last, because it needs the table offsets settled above.
  //
  // Three cases, and only one of them refuses:
  //   • present and MATCHES  → verified. The block is byte-for-byte what its writer wrote.
  //   • present and DIFFERS  → quarantine. This is the SB-051 chimera: a structurally valid,
  //     semantically wrong block. Refusing here rather than in the parser means `writeVaultBlock`
  //     is gated too (it re-locates), so DD-009's "does not import AND does not write until it
  //     is resolved" holds without a second check anywhere.
  //   • ABSENT               → verified: false. Parses, unverified, NEVER quarantined
  //     (DD-009 consequence 2) — the back-compat and hand-made-block path.
  const verified = digest != null;
  const payloadLines = [lines[headerLine], lines[separatorLine]].concat(rowLines.map((ln) => lines[ln]));
  if (verified && digest !== vaultPayloadDigest(payloadLines)) return vaultQuarantine('digest-mismatch');

  return {
    quarantine: false,
    heading,
    start,
    end: revisionLine, // inclusive — the splice in writeVaultBlock replaces start..end
    headerLine,
    separatorLine,
    rowLines,
    // the column count comes from the header row, so a totals row that does not match the
    // declared width is not treated as generated — it falls through to the row-level checks
    totalsLine:
      rowLines.length && isTotalsRow(lines[rowLines[rowLines.length - 1]], vaultRowCells(lines[headerLine]).length)
        ? rowLines[rowLines.length - 1]
        : -1,
    revisionLine,
    revision,
    digest,
    verified,
  };
};

// ---- adoption: TT writes the bottom anchor for a region it can describe (DD-012) ----
// Terje, resolving SB-089: *"if I create a daily note by hand, I can't write to it with TT?
// That needs a solution."* This is the solution, and its precondition is strict. Adoption
// applies when BOTH hold:
//
//   1. the anchor heading is present EXACTLY ONCE (name from settings, never hardcoded), and
//   2. everything between it and the next `##` — or EOF — is either EMPTY, or a single
//      well-formed TT table and nothing else.
//
// Anything else still quarantines exactly as before: prose under the heading, a second table,
// an unparseable row, a header outside the vocabulary, more than one anchor heading, and a
// CRLF taint (SB-084's signal is computed before any branch and wins — a tainted file is not
// an adoptable one).
//
// WHY THIS IS SAFE, given SB-057 made both anchors mandatory on purpose. That rule exists so a
// missing bottom anchor can never let a write run into `## Captures`, and the
// `revision-past-next-heading` check already bounds the scan to the region before the next
// heading. Under the precondition above that region is one TT can describe COMPLETELY — so
// inserting the anchor writes nothing TT did not author, which is the actual invariant being
// protected. Two structural properties keep it that way, and both are asserted:
//   • adoption is attempted ONLY when the locator's verdict is exactly 'no-revision', which
//     already means: not CRLF-tainted, exactly one anchor heading, and no `revision:` line
//     anywhere in the note — including past the hard stop, which stays its own refusal.
//   • adoption only ever INSERTS lines, inside `vaultAnchorScan`'s bounds. It replaces no line
//     and deletes none, so a byte outside the region cannot move even in principle.
//
// AND IT IMPORTS THE ROWS. A well-formed table already in the note becomes TT entries — the
// point of the ticket, since a note Terje typed an hour into should work. That makes adoption a
// READ path into the data model, not only a write path, so there is no shortcut anywhere here:
// this function only synthesises the missing anchor, and the resulting note goes through the
// same `parseAnchoredBlock` — the same header vocabulary, the same cell primitives, the same
// row-level quarantine — as any block TT wrote itself. Validation is that parse, not a second
// opinion living here; a shape-only precondition would have adopted all 60 pre-cutover notes
// (they DO carry `## Time Log` and a well-shaped table — it is `Cat`/`Description` failing the
// vocabulary that keeps SB-049 closed, not the heading).
/**
 * @param {string} md @param {{ heading?: string }} [opts]
 * @returns {string | null} the note with the missing anchor inserted — an INPUT to the parse,
 *   never bytes for disk — or null when adoption does not apply.
 */
function vaultAdoptionCandidate(md, opts) {
  const loc = TT.locateVaultBlock(md, opts);
  // 'no-revision' and nothing else. A located block needs no adopting, and every other refusal
  // is one adoption is not entitled to overrule.
  if (!loc.quarantine || loc.reason !== 'no-revision') return null;
  const lines = md.split('\n');
  const heading = nfc(((opts && opts.heading) || VAULT_HEADING).trim());
  const { count, start, stop } = vaultAnchorScan(lines, markFences(lines), heading);
  if (count !== 1) return null; // unreachable via 'no-revision'; the narrowing is the point
  let last = -1; // the last non-blank line of the region
  for (let i = start + 1; i < stop; i++) if (lines[i].trim() !== '') last = i;
  // An EMPTY region needs a table before it can carry an anchor at all — the locator requires
  // one — so TT authors that too, taken from the serializer rather than composed here so the
  // block's shape keeps exactly one emitter. Its revision line is dropped in favour of the
  // digest-less one below; everything before it is `['## <heading>', '', header, delimiter,
  // totals]`, and the heading is dropped because the note already has it, byte for byte.
  const empty = TT.serializeVaultBlock([], { heading }).split('\n').slice(1, -2);
  const insert = last < 0 ? empty.concat('', VAULT_ADOPTED_ANCHOR) : ['', VAULT_ADOPTED_ANCHOR];
  const at = last < 0 ? start + 1 : last + 1;
  return lines.slice(0, at).concat(insert, lines.slice(at)).join('\n');
}

// ---- vault block parse (SB-055) ----
// THE HEADER ROW IS THE SCHEMA (SB-045). Keys are the lowercased header labels
// (`Task` → `task`); there is no `cols=` attribute anywhere. Headers are canonical
// ENGLISH and never routed through client/src/i18n.ts (DD-007) — the file on disk is
// not a UI surface.
//
// THE VOCABULARY RULE resolves what reads as a contradiction between two settled
// rulings. SB-045 ruling 2: an unrecognised header quarantines, never guesses a
// remapping. The `cols=` rationale: a block written before a column existed must keep
// parsing. Both hold under ONE rule — TT knows a fixed vocabulary of canonical-English
// labels, any SUBSET of it in any ORDER parses (that is the migration-free property),
// and any label OUTSIDE it quarantines (that is ruling 2). SB-044 later extends the
// vocabulary from settings; nothing else changes. Membership is case-insensitive
// because the key IS the lowercased label — that is a definition, not a guess — and the
// block's own label spelling is preserved for re-emission, so bytes still round-trip.
//
// THE PASSTHROUGH. Any vocabulary column TT has no model mapping for is carried RAW (still
// escaped) on `entry.vaultCells` and re-emitted verbatim — re-emitting exactly the bytes it
// read is the only lossless option for a value TT cannot interpret.
//
// SB-059 EMPTIED IT. `Mode` was its only occupant; it is `Entry.tags` now, so as of today
// every vocabulary column has a model field and a parse never produces `vaultCells` at all.
// The mechanism stays because SB-044's settings-extended vocabulary lands on it — a column
// TT is told about but has no field for is exactly what it is for. Do not delete it for
// being unused; that is the state it is supposed to be in.
//
// PROJECT RESOLVES ONLY WITH A CATALOG (SB-059). `opts.projects` present ⇒ a `[[Wikilink]]`
// cell whose note some project claims via `Project.vaultNote` parses to that project's CODE,
// which is what the model holds. Absent, or claimed by nobody, the cell is carried literally
// into `entry.project` — the pre-SB-059 behaviour, unchanged. See `vaultProjectCode`.
//
// ROW-LEVEL QUARANTINE. A row that parses as neither an entry nor the generated totals
// row quarantines the whole block. It is not dropped and not guessed — that is what
// stops a corrupted Time cell from silently vanishing an hour of Terje's day.
// SDD-004 DROPPED THIS TO FOUR COLUMNS. `Project` folds into `Task` (task 1's merged codec) and
// `Bill` becomes `$`. What a NEW block is written with, and nothing else — `serializeVaultBlock`
// re-emits each block's OWN header set, so the six TT-written notes on disk keep five columns
// forever. Terje ruled no migration.
const VAULT_COLUMNS = ['Time', 'Mode', 'Task', '$'];
// THE VOCABULARY IS NOT DERIVED FROM THE COLUMNS ANY MORE, and must not go back to being derived.
// It is the union of every header TT can READ, which is now strictly larger than what it WRITES:
// `project` and `bill` are retired from the canonical set but still parse, which is the whole
// reason nothing on disk migrates.
//
// WIDENING THIS LIST IS A SAFETY ACT, NEVER A FORMALITY (SB-044). DD-012 adoption's precondition
// is a well-formed table under the heading, so this vocabulary is the ONLY thing standing between
// adoption and TT importing Terje's 80 pre-cutover daily notes — which SB-049 ruled must stay
// untouched and invisible. They head `| Time | Cat | Project | Description |`, so `cat` and
// `description` are the forbidden words and the guard for them lives in tests/roundtrip.test.js.
// SDD-004 added exactly one word, `$`, measured against the live vault on 2026-08-03: of 91 daily
// notes, none uses `$` as a header, and the parse verdict for all 91 is identical before and after.
// EXPORTED so the round-trip guard in tests/roundtrip.test.js is driven by the list itself rather
// than by a hand-kept copy of it. Same reason SB-109 exported the quarantine reasons: a guard that
// re-declares what it guards goes stale silently, and this particular list going stale is how a
// column TT can READ ends up being one TT cannot WRITE. SDD-004 is the case in point — `$` was
// added here, and the hand-kept copy in that guard did not notice.
// Deliberately NOT `/** @type {const} */` — unlike the quarantine reasons, this list is READ
// against arbitrary header text (`includes(key)` on a plain string), so narrowing it to a literal
// tuple makes every such check a type error. `readonly` instead: the check still compiles, and the
// one thing standing between adoption and Terje's 80 pre-cutover notes cannot be pushed to by an
// importer.
/** @type {readonly string[]} */
export const VAULT_HEADER_VOCABULARY = ['time', 'mode', 'project', 'task', 'bill', '$'];
const BILL_YES = '✓'; // U+2713. SB-045: `✓` or blank — never `—`, and nothing else parses.
// The `$` column's own two spellings (SDD-004). It is NOT `bill` renamed: `bill` spells
// non-billable as a BLANK cell, `$` spells it `0`. Both columns refuse the other's vocabulary
// rather than guessing, because this cell decides money.
const DOLLAR_NO = '0';
/**
 * SDD-004's gate: does this block's `Task` column carry the merged project-and-task cell, or just
 * label-and-note? ONE DEFINITION, because the parser and the serializer both ask it and a block
 * read merged but written unmerged loses the project out of the note — or worse, reads a label's
 * colon as a project. That is the drift this file keeps unifying away: `TOTALS_CELL_RE` is shared
 * by detection and emission "which is what makes them one decision", and `normaliseVaultPayloadLine`
 * is exported so the writer cannot grow a second normaliser. Two copies that merely agree today is
 * the same shape of mistake.
 *
 * It is keyed on the ABSENCE of `project`, never on the presence of `$`. The merged codec exists
 * precisely because there is no separate project column, so that is the direct condition; keying on
 * `$` would be a coincidence of SDD-004 and would break the moment a block carries one without the
 * other. This is SB-045's "the header row is the schema" applied one level down.
 *
 * Computed ONCE PER BLOCK from the header row, never per cell. A degenerate header set like
 * `| Time | Task |` has no `project` column, so it falls on the merged side and its Task cells
 * split on a colon.
 * @param {string[]} keys the block's header row, lowercased @returns {boolean}
 */
const isMergedTaskColumn = (keys) => !keys.includes('project');
/**
 * Parse a note that ALREADY carries both anchors, or propagate the locator's verdict. The
 * adoption-aware entry point is `TT.parseVaultBlock` below, which is this function plus the
 * DD-012 pre-step; everything that must not adopt twice — the adoption candidate's own
 * validation, and `writeVaultBlock`'s output gate — calls this one.
 * @param {string} md @param {{ heading?: string, date?: string, projects?: Project[] }} [opts]
 * @returns {import('./types.ts').VaultBlockParseResult}
 */
function parseAnchoredBlock(md, opts) {
  const loc = TT.locateVaultBlock(md, opts);
  if (loc.quarantine) return loc; // propagated UNCHANGED — the locator owns its reasons
  const lines = String(md == null ? '' : md).split('\n');
  const date = (opts && opts.date) || '';
  const projects = (opts && opts.projects) || undefined; // absent ⇒ Project cells stay verbatim

  // the header row IS the schema
  const headers = vaultRowCells(lines[loc.headerLine]);
  /** @type {string[]} */
  const keys = [];
  for (const label of headers) {
    const key = label.toLowerCase();
    if (!VAULT_HEADER_VOCABULARY.includes(key)) return vaultQuarantine('unknown-header');
    if (keys.includes(key)) return vaultQuarantine('duplicate-header');
    keys.push(key);
  }
  const merged = isMergedTaskColumn(keys); // SDD-004 — see the predicate for why it keys on `project`

  /** @type {VaultEntry[]} */
  const entries = [];
  for (const ln of loc.rowLines) {
    if (ln === loc.totalsLine) continue; // generated, never round-tripped as an entry
    const cells = vaultRowCells(lines[ln]);
    if (cells.length !== keys.length) return vaultQuarantine('row-cell-count');
    /** @type {VaultEntry} */
    const entry = {
      // DD-008: the runtime id is EPHEMERAL — minted here only because the React key and
      // the mutation handle need one. It must NEVER be written back to disk; phase 3
      // derives the persistence key from the row's own content (see the canonical row
      // string spec beside the serializer).
      id: nid(),
      date,
      start: null,
      end: null,
      durMin: null,
      project: null,
      label: '',
      note: '',
      // no Bill column at all (a pre-Bill block) → billable, matching TT.projectBillable's
      // "billable unless something says otherwise"
      billable: true,
    };
    /** @type {Record<string, string> | null} */
    let vaultCells = null;
    for (let c = 0; c < keys.length; c++) {
      const raw = cells[c];
      if (keys[c] === 'time') {
        // an EMPTY Time cell is legal — that is an entry with no time yet, which the app
        // can hold (TT.newEntry with no parsed time). A non-empty cell that will not parse
        // is the dangerous one, and it quarantines rather than dropping the hour.
        if (raw !== '') {
          const parsed = TT.parseTimeCell(raw);
          if (!parsed) return vaultQuarantine('unparseable-time');
          applyParsed(entry, parsed);
        }
      } else if (keys[c] === 'mode') {
        // SB-059: an empty cell leaves `tags` ABSENT rather than `[]` — the emit-when-set
        // discipline `editedByAdmin` already follows, and it keeps a blank Mode cell and a
        // block with no Mode column reading the same way (DD-008 rule 8 keys them identically)
        const tags = TT.decodeTagsCell(raw);
        if (tags.length) entry.tags = tags;
      } else if (keys[c] === 'project') {
        entry.project = raw === '' ? null : vaultProjectCode(raw, projects);
      } else if (keys[c] === 'task') {
        if (merged) {
          const { project, label, note } = TT.decodeMergedTaskCell(raw);
          entry.project = project;
          entry.label = label;
          entry.note = note;
        } else {
          const { label, note } = TT.decodeTaskCell(raw);
          entry.label = label;
          entry.note = note;
        }
      } else if (keys[c] === 'bill') {
        // exactly `✓` or exactly blank. Anything else is a hand edit whose intent TT
        // cannot know, and this cell decides money — so it refuses instead of guessing.
        if (raw === BILL_YES) entry.billable = true;
        else if (raw === '') entry.billable = false;
        else return vaultQuarantine('bad-bill-cell');
      } else if (keys[c] === '$') {
        // SDD-004's spelling of the same decision, and it refuses the same way. `0` rather than a
        // blank, so the column reads as one symbol at two states instead of a mark and an absence
        // — a blank `$` cell is therefore NOT a reading, it is a cell TT cannot account for.
        //
        // The refusal reports `bad-bill-cell`, which names the MODEL FIELD this cell decides, not
        // the header it was spelled with. One failure, one reason: a second name for "the
        // billability cell cannot be read" would put DD-007's two-vocabulary cost into the
        // diagnostics as well as the file.
        if (raw === BILL_YES) entry.billable = true;
        else if (raw === DOLLAR_NO) entry.billable = false;
        else return vaultQuarantine('bad-bill-cell');
      } else {
        (vaultCells || (vaultCells = {}))[keys[c]] = raw;
      }
    }
    if (vaultCells) entry.vaultCells = vaultCells;
    entries.push(entry);
  }

  // `verified` rides along from the locator (DD-009): SB-057's arbitration matrix row 2 splits on
  // it — `file rev == index rev, hash differs` is a genuine bumpless hand-edit only when the block
  // verified, and a digest MISMATCH never reaches here at all (the locator quarantines it).
  return {
    quarantine: false,
    heading: loc.heading,
    revision: loc.revision,
    headers,
    entries,
    verified: loc.verified,
    adopted: false, // overridden by TT.parseVaultBlock when the anchor was synthesised
  };
}
/**
 * Parse the vault block into entries, ADOPTING the note first if DD-012's precondition holds,
 * or propagate the quarantine verdict. `opts.date` is the note's date: SB-045's format has NO
 * date column (the filename carries it), so SB-056/SB-057 supply it here. It defaults to ''
 * rather than today, so a caller that forgets it produces a visibly dateless entry instead of a
 * silently misdated one.
 *
 * An adopted note reports `adopted: true` and `verified: false`. The `verified` half needs no
 * special case here and deliberately does not have one: `VAULT_ADOPTED_ANCHOR` carries no digest,
 * so DD-009's own machinery — a digest-less block parses UNVERIFIED, never quarantined, which is
 * exactly the hand-made-block path it was written for — already reports it. Forcing it here as
 * well would be a second lock on the same door, and two rules that merely agree today is the
 * drift this file keeps unifying away.
 * @param {string} md @param {{ heading?: string, date?: string, projects?: Project[] }} [opts]
 * @returns {import('./types.ts').VaultBlockParseResult}
 */
TT.parseVaultBlock = function (md, opts) {
  const input = String(md == null ? '' : md);
  const candidate = vaultAdoptionCandidate(input, opts);
  // The candidate is validated by the parse itself — that IS the "no shortcut" rule (DD-012).
  // A candidate that will not parse quarantines on what actually stopped TT from describing the
  // region ('no-table', 'unknown-header', 'unparseable-time', …), which is strictly more useful
  // than the 'no-revision' it used to report; after DD-012 a missing bottom anchor is no longer
  // a refusal by itself, so 'no-revision' is a locator-only verdict now.
  const parsed = parseAnchoredBlock(candidate == null ? input : candidate, opts);
  if (parsed.quarantine || candidate == null) return parsed;
  return { ...parsed, adopted: true };
};

// ---- vault block serialize + splice (SB-055) ----
// Emits SB-045's frozen shape in OBSIDIAN'S ALIGNED FORM (DD-023 — the columns are padded, the
// schema is untouched):
//
//   ## Time Log
//
//   | Time        | Mode   | Project      | Task                  | Bill |
//   | ----------- | ------ | ------------ | --------------------- | ---- |
//   | 09:00→09:15 | #admin | [[Planning]] | Daily planning ritual |      |
//   | **8.7h**    |        |              |                       | **5.1h billable** |
//
//   `revision: 8`
//
// The header row is written ALWAYS, including on a zero-entry day — no header means no
// schema.
//
// DD-023 CHANGED THE PADDING, NOT THE FORMAT: same five columns, same anchor heading, same
// revision line, same digest in it. The reason is that Obsidian's table editor re-pads a table
// the moment a cell is edited, which under a raw-byte digest mismatched and quarantined the day —
// and TT then silently stopped writing to it (SB-155). TT emitting what Obsidian would emit is
// half the fix; the digest comparing NORMALISED text (see `vaultPayloadDigest`) is the half that
// makes every note already on disk keep verifying.
//
// THE TASK CELL USES TT.encodeTaskCell, NEVER TT.encodeNoteCell. encodeNoteCell escapes a
// trailing `[nb]`/`[ea]` run, which is the v2 MIRROR's flag convention; the vault carries
// billability in a dedicated `Bill` column, so routing through it would put a spurious
// backslash on a note that happens to end in `[nb]`.
/**
 * One table line in the CANONICAL (compact) form. An empty cell is a single space, matching
 * SB-045's example bytes.
 *
 * SINCE DD-023 THIS IS NO LONGER WHAT REACHES DISK — `vaultAlignedTable` is. What this is now is
 * the digest's normalisation target: `normaliseVaultPayloadLine` re-emits every table row through
 * here, so "the canonical form" is defined by this expression rather than described in prose
 * somewhere. That is what makes the compact form a FIXED POINT and therefore makes DD-023 free of
 * migration: every block already on disk was written by this expression, so it normalises to
 * itself and the digest in its anchor still verifies. Change these bytes and every note TT has
 * ever written re-hashes to a new value and quarantines on first read.
 * @param {string[]} cells @returns {string}
 */
const vaultRow = (cells) => '|' + cells.map((c) => (c === '' ? ' ' : ' ' + c + ' ')).join('|') + '|';
// The delimiter row's canonical form, and it is a DIFFERENT RULE from `vaultRow` — no framing
// spaces at all, `|---|---|`. That is why it is its own expression and not
// `vaultRow(cells.map(() => '---'))`, which would emit `| --- | --- |` and stop matching what is
// already on disk. One dash run per column, three dashes, exactly what `serializeVaultBlock`
// emitted before DD-023.
//
// AN ALIGNMENT COLON IS CARRIED, not collapsed. The scope bound on this normaliser (Architect,
// SB-165) is "framing whitespace and the separator row's dash run, nothing else" — a `:` is
// neither. TT never writes one, so carrying it costs nothing and dropping it would silently make
// a human's alignment choice invisible to the digest.
const DELIMITER_CELL_RE = /^(:?)-+(:?)$/;
/** @param {string[]} cells already trimmed, from `vaultRowCells` @returns {string} */
const vaultDelimiterRow = (cells) =>
  '|' +
  cells
    .map((c) => {
      const m = DELIMITER_CELL_RE.exec(c);
      return m ? m[1] + '---' + m[2] : c;
    })
    .join('|') +
  '|';
/**
 * One payload line in canonical form — the shape `vaultPayloadDigest` hashes (DD-023 half 2).
 *
 * BUILT BY RE-EMITTING THROUGH THE CANONICAL EMITTERS, never by a hand-rolled trim-and-join. The
 * obvious `'| ' + cell.trim() + ' |'` implementation is wrong twice over and both are live on
 * Terje's own note: it gives `|  |` for an empty cell where `vaultRow` gives `| |`, and
 * `| --- | --- |` for the delimiter where the emitter gives `|---|---|`. Neither is a fixed
 * point, so `normalise(compact) !== compact`, and every existing block quarantines on first
 * read — DD-023's own failure mode arriving from DD-023. Parsing to cells and re-emitting cannot
 * get that wrong, because there is then only one definition of a row.
 *
 * WHAT IT IS ALLOWED TO LOSE, per DD-023: a change that is purely framing whitespace becomes
 * undetectable. SB-075's write-edge trim means the store cannot hold a value that differs from
 * another only by surrounding whitespace, so detecting it protected nothing. Interior runs are
 * NOT collapsed — `a  b` in a label is content, and `vaultRowCells` only trims the edges.
 * DD-009's SB-051 chimera detection is unaffected: a diff-merge keeps the buffer's ROWS, which
 * changes cell content and still mismatches.
 *
 * A line that is not a table row comes back untouched. The payload is header + delimiter + data
 * rows (DD-009 consequence 1), so that branch is unreachable through `vaultPayloadDigest`; it is
 * there so the writer's skip test, the second call site, can hand this whole block regions.
 * @param {string} line @returns {string}
 */
function normaliseVaultPayloadLine(line) {
  // the delimiter test first — a delimiter row IS a table row, and it has the other rule
  if (isDelimiterRow(line)) return vaultDelimiterRow(vaultRowCells(line));
  return isTableRow(line) ? vaultRow(vaultRowCells(line)) : line;
}
// Exposed for `server/src/vault-write.js`'s diff-before-write, which compares WHOLE NOTE TEXT and
// so cannot go through `vaultPayloadDigest` (DD-023 half 2 covers the skip test too). TWO CALL
// SITES, ONE DEFINITION — a second normaliser over there would be two rules that merely agree
// today, and the one that drifts turns a fixed quarantine into a per-keystroke iCloud write storm.
TT.normaliseVaultPayloadLine = normaliseVaultPayloadLine;
/**
 * The table's lines in OBSIDIAN'S ALIGNED FORM (DD-023 half 1) — header row, delimiter row, then
 * the data rows. THIS is what reaches disk.
 *
 * Takes cell ARRAYS rather than lines because a column's width is not known until every row is in
 * hand; that is why both serializers now build their rows as cells and emit here at the end
 * instead of pushing a finished line per row.
 *
 * DD-023's algorithm, measured against Terje's vault rather than assumed — `2026-07-03.md` has
 * every raw cell at `width + 2` on all four of its columns, the delimiter row included:
 *
 *   width  = max str.length over the header row and every data row (the delimiter is DERIVED)
 *   cell   = "| " + content.padEnd(width) + " "
 *   dashes = "-".repeat(width)
 *
 * WIDTH IS `str.length` — UTF-16 CODE UNITS, not code points and not display width. DD-023
 * measured `11:00→13:00 🕐` against the real file: 13 code points, 14 code units, and Obsidian
 * wrote 14 dashes. A `[...str].length` implementation is off by one on that exact row, so the
 * table Obsidian re-aligns is not the table TT wrote and the note wedges again.
 *
 * NO EMPTY-CELL SPECIAL CASE, deliberately unlike `vaultRow`. `vaultRow` writes `| |` for an
 * empty cell, citing SB-045's example bytes; Obsidian pads an empty cell to the full column width
 * like any other (observed in `Calendar/Daily/2026-02-09.md`). Keeping TT's single-space case
 * here would leave Obsidian re-aligning every table TT writes — silent and harmless now that half
 * 2 stops the quarantine, but permanent ping-pong, and stopping exactly that churn is what half 1
 * is for. DD-023's algorithm has no exception and neither does the observation.
 *
 * The width floors at 1 so a block whose header row carries an EMPTY label still emits a
 * delimiter with a dash in it. A zero-dash cell is not a delimiter row to any parser, TT's
 * `isDelimiterRow` included, so the floor is what keeps a degenerate header set writable rather
 * than a claim about what Obsidian would do.
 * @param {string[][]} rows the header cells first, then one array per data row
 * @returns {string[]}
 */
function vaultAlignedTable(rows) {
  const widths = rows[0].map((_, j) => rows.reduce((w, cells) => Math.max(w, (cells[j] || '').length), 1));
  /** @param {string[]} cells @returns {string} */
  const line = (cells) => '|' + widths.map((w, j) => ' ' + (cells[j] || '').padEnd(w) + ' ').join('|') + '|';
  const delimiter = '|' + widths.map((w) => ' ' + '-'.repeat(w) + ' ').join('|') + '|';
  return [line(rows[0]), delimiter].concat(rows.slice(1).map(line));
}
// Exposed on the same grounds as `vaultPayloadDigest`: since DD-023 this is part of the BLOCK
// FORMAT CONTRACT rather than an implementation detail of the two serializers — it decides the
// bytes that reach the vault. And its rule is a claim about a program TT does not control, so it
// has to be pinnable directly against a recorded Obsidian table; going through
// `serializeVaultBlock` to check it would mix the parser, `vaultTimeSeparator` and the totals row
// into an assertion that is only about column widths.
TT.vaultAlignedTable = vaultAlignedTable;
// THE REVISION LINE HAS EXACTLY ONE EMITTER — this one. SB-078 came back YES, so the digest
// lands HERE and nowhere else (DD-009); see the ruling next to `REVISION_RE`, which is the sole
// matcher. Do not inline this string anywhere.
//
// TT ALWAYS writes a digest. The digest-less shape is a read-side concession to blocks TT did
// not write (DD-009 consequence 2), never an emitter option — which is what makes detection work
// at all: the merge preserves TT's anchor line, so a TT-written block keeps its digest and
// mismatches. An emitter that could omit it would hand the chimera a way to look unverified
// instead of wrong.
/** @param {number} revision @param {string} digest @returns {string} */
const vaultRevisionLine = (revision, digest) => '`revision: ' + revision + ' · ' + digest + '`';
// The anchor ADOPTION synthesises (DD-012) — `revision: 1`, and no digest.
//
// This does not reopen the rule above, because it is not an emitter option and these bytes never
// reach disk: `vaultAdoptionCandidate` builds a note for the PARSER to read, and every write of
// an adopted note re-serializes the whole region through `vaultRevisionLine`, so what lands on
// disk carries a digest like any other block. What a digest here would mean is the problem —
// taken over the hand-written rows it is supposed to verify, it says only "these bytes are these
// bytes", and SB-057's arbitration is entitled to trust `verified`. Digest-less is DD-009
// consequence 2's own shape for a block TT did not write, so this single choice is also what
// makes an adopted parse report `verified: false`: no special case anywhere, in either branch —
// including the empty region, whose table TT did author. Give this line a digest and adoption
// starts claiming verification of bytes it has never seen before.
//
// Spelled against REVISION_RE, which is the sole matcher: `1` because DD-012 says a first write
// starts there, and `serializeVaultBlock`'s own default agrees.
const VAULT_ADOPTED_ANCHOR = '`revision: 1`';
// SB-077 (Terje, ruled 2026-07-25): a RUNNING entry contributes 0 to the note's totals,
// regardless of date. The daily note is a record of FINISHED work, not a live display — the
// row is written once with its open range (`15:30→`) and left alone until an end time lands.
// Do NOT delegate to TT.entryMinutes: it deliberately returns wall-clock elapsed for a
// today-dated running entry, which is right for the app's live total and wrong here. Two
// questions, two helpers; the app keeps the live one. This is also what makes the emitted
// bytes clock-independent, so the running-timer golden can be written for the case SB-055
// actually names instead of a past-dated proxy for it.
/** @param {Entry} entry @returns {number} */
function vaultEntryMinutes(entry) {
  if (entry.durMin != null) return entry.durMin;
  if (entry.start == null || entry.end == null) return 0; // running, or no time yet
  const minutes = entry.end - entry.start;
  return minutes < 0 ? minutes + 1440 : minutes; // overnight rolls into the next day
}
// The single named totals helper. No client rounding is applied — the vault block has no
// client or rate model (that is the app's surface); this row is hours worked, not money.
/** @param {Entry[]} entries @returns {{ min: number, bill: number }} */
function vaultTotals(entries) {
  let min = 0,
    bill = 0;
  for (const entry of entries) {
    const m = vaultEntryMinutes(entry);
    min += m;
    if (entry.billable) bill += m;
  }
  return { min, bill };
}
/**
 * Serialize entries into the block's region bytes — the `## <heading>` line through the
 * `` `revision: N` `` line, with no trailing newline (the splice supplies the line breaks).
 * `opts.headers` is the block's OWN declared header set, so a block written before a column
 * existed re-emits its own columns; it defaults to the canonical five.
 *
 * `opts.timeSeparator` (SB-063) is `Settings.vaultTimeSeparator` — and this is the ONLY door
 * it comes through. The v2 mirror shares TT.fmtTimeCell but does not share this option, so
 * the setting cannot move a mirror byte (SB-069).
 *
 * `opts.projects` (SB-059) is the catalog the `Project` column renders through — the same
 * opt-in shape, and for the same reason: absent, the entry's project code is written bare,
 * which is byte-for-byte what TT wrote before SB-059.
 * @param {VaultEntry[]} entries
 * @param {{ heading?: string, headers?: string[], revision?: number, timeSeparator?: VaultTimeSeparator, projects?: Project[] }} [opts]
 * @returns {string}
 */
TT.serializeVaultBlock = function (entries, opts) {
  const rows = entries || [];
  const heading = (opts && opts.heading) || VAULT_HEADING;
  const headers = (opts && opts.headers && opts.headers.length ? opts.headers : VAULT_COLUMNS).slice();
  const revision = opts && opts.revision != null ? opts.revision : 1; // a first write starts at 1
  const timeSeparator = (opts && opts.timeSeparator) || undefined; // absent ⇒ `unicode`, today's bytes
  const projects = (opts && opts.projects) || undefined; // absent ⇒ the bare project code
  const keys = headers.map((label) => label.toLowerCase());
  const merged = isMergedTaskColumn(keys); // SDD-004 — the SAME predicate the parser calls, by construction

  // CELLS, not finished lines — `vaultAlignedTable` cannot know a column's width until the last
  // row is in hand, so the rows are collected and emitted together at the end (DD-023 half 1).
  const cellRows = [headers];
  for (const entry of rows) {
    cellRows.push(
      keys.map((key) => {
        if (key === 'time') return TT.fmtTimeCell(entry, timeSeparator);
        if (key === 'mode') return TT.encodeTagsCell(entry.tags);
        if (key === 'project') return entry.project ? vaultProjectCell(entry.project, projects) : '';
        if (key === 'task')
          return merged
            ? TT.encodeMergedTaskCell({ project: entry.project, label: entry.label, note: entry.note }, projects)
            : TT.encodeTaskCell({ label: entry.label, note: entry.note });
        if (key === 'bill') return entry.billable ? BILL_YES : '';
        if (key === '$') return entry.billable ? BILL_YES : DOLLAR_NO;
        // a vocabulary column TT has no model field for — re-emitted verbatim from the raw
        // cell the parser carried. Empty today (SB-059 gave `Mode` a home); SB-044's
        // settings-extended vocabulary is what refills it
        return (entry.vaultCells && entry.vaultCells[key]) || '';
      }),
    );
  }
  // The totals row is KEYED, not positional: the hours total sits under `Time` and the
  // billable total under `Bill`, which is what SB-045's example means — those are simply
  // columns 0 and 4 in the canonical order, so for a canonical block the two readings are the
  // same bytes. A block whose header row was reordered by hand gets its totals under the
  // right headings instead of under whatever happens to be first and last.
  //
  // This composes with detection because isTotalsRow keys on the CELL SHAPE
  // (TOTALS_CELL_RE), not on position — the two rules share that regex, which is what makes
  // them one decision. Fallbacks keep a degenerate header set writable: no billability column at
  // all puts that total in the last one, no `Time` column puts the hours in column 0, and if those
  // collide the hours win (a one-column block has nowhere else to put them).
  //
  // THE LABEL FOLLOWS THE COLUMN, exactly as the header does (SDD-004): ` billable` under `Bill`,
  // bare under `$`. It is not decoration — it is 9 characters, and `vaultAlignedTable` pads the
  // whole column to its widest cell. `**3h billable**` under `$` would make the new block 80
  // characters against the old shape's 81, which is the entire measured reason for the change
  // gone. `TOTALS_CELL_RE` needs no edit for it: ` billable` is already optional there, so
  // detection reads both spellings and the two rules stay one decision.
  const { min, bill } = vaultTotals(rows);
  const totals = headers.map(() => '');
  const timeAt = keys.indexOf('time') >= 0 ? keys.indexOf('time') : 0;
  const dollarAt = keys.indexOf('$');
  const billAt = keys.indexOf('bill') >= 0 ? keys.indexOf('bill') : dollarAt >= 0 ? dollarAt : headers.length - 1;
  totals[timeAt] = '**' + TT.fmtHours(min) + 'h**';
  if (billAt !== timeAt) totals[billAt] = '**' + TT.fmtHours(bill) + 'h' + (billAt === dollarAt ? '' : ' billable') + '**'; // prettier-ignore
  cellRows.push(totals);
  // `lines` is `['## heading', '', header, delimiter, ...rows]` at this point, so everything from
  // index 2 to the end IS the payload — taken before the blank line and the revision line are
  // appended, which is what keeps them out of it without any filtering. The totals row is part of
  // the width computation like any other data row, which is why it goes into `cellRows` rather
  // than being appended to `lines` after the fact.
  const lines = ['## ' + heading, ''].concat(vaultAlignedTable(cellRows));
  lines.push('', vaultRevisionLine(revision, vaultPayloadDigest(lines.slice(2))));
  return lines.join('\n');
};
/**
 * Write entries into the note's vault block, leaving every byte outside the block's region
 * untouched. Intentions, Habits, Captures and Reflection are Terje's, not TT's.
 *
 * The gate is the PARSER, not just the locator: a block whose header set or rows the parser
 * refuses is quarantined, and it must be impossible to reach a write from a quarantined
 * block. On any verdict the input `md` comes back byte-identical.
 *
 * The OUTPUT is gated too, not just the input. TT.encodeCell escapes `\` and `|`; it does not
 * escape a newline, and TT.fmtDur emits `0m` for a zero duration, which parseTimeCell rejects.
 * Either would produce a block TT's own parser refuses — a note frozen against TT until a
 * human repairs it by hand, reported as a successful write. So the spliced result is parsed
 * back before it is returned, and anything that would not survive the round-trip is refused
 * as 'write-would-corrupt' with the input handed back untouched. One gate, whole class.
 *
 * The revision is NOT bumped here. `opts.revision` sets it; absent, the located revision is
 * re-emitted unchanged. When a write bumps the counter is SB-057's arbitration to rule on,
 * not this function's to assume.
 *
 * ADOPTION (DD-012). A note carrying the heading but no bottom anchor is written rather than
 * quarantined, provided TT can describe its whole region — see `vaultAdoptionCandidate`. The
 * splice then runs against the ADOPTED note, so the anchor it inserted is immediately replaced
 * by the serialized one, digest and all; nothing outside `vaultAnchorScan`'s bounds is reachable
 * either way. `adopted` rides on the result because an adopted note's first write has no prior
 * `(rev, hash)` in SB-057's index at all — a genuinely new arbitration row, not a variant of an
 * existing one — and inferring that from an empty index entry is a weaker signal than being told.
 * @param {string} md @param {VaultEntry[]} entries
 * @param {{ heading?: string, date?: string, headers?: string[], revision?: number, timeSeparator?: VaultTimeSeparator, projects?: Project[] }} [opts]
 * @returns {{ md: string, quarantine: boolean, reason: import('./types.ts').VaultQuarantineReason | null, adopted: boolean }}
 */
TT.writeVaultBlock = function (md, entries, opts) {
  const input = String(md == null ? '' : md);
  const candidate = vaultAdoptionCandidate(input, opts);
  const adopted = candidate != null;
  // everything below reads `source`; every refusal hands back `input`, so a note that was
  // adopted in memory and then refused downstream still comes back byte-identical
  const source = adopted ? /** @type {string} */ (candidate) : input;
  const parsed = parseAnchoredBlock(source, opts);
  if (parsed.quarantine) return { md: input, quarantine: true, reason: parsed.reason, adopted: false };
  // Re-locating is not redundant: parseAnchoredBlock returns values, not line offsets, and this
  // also narrows the union for @ts-check so `loc.heading` below is legal. Do not delete it.
  const loc = TT.locateVaultBlock(source, opts);
  if (loc.quarantine) return { md: input, quarantine: true, reason: loc.reason, adopted: false };
  const lines = source.split('\n');
  const region = TT.serializeVaultBlock(entries, {
    heading: loc.heading,
    // `[]` is truthy, so an explicit empty header list would silently fall through to the
    // canonical five and re-canonicalise a block — the opposite of the migration-free property
    headers: opts && opts.headers && opts.headers.length ? opts.headers : parsed.headers,
    revision: opts && opts.revision != null ? opts.revision : loc.revision,
    // SB-063: absent ⇒ `unicode`. The write-would-corrupt gate below re-parses the result,
    // so a bad value can never leave a note TT's own parser refuses.
    timeSeparator: opts && opts.timeSeparator,
    // SB-059: the SAME catalog the parse above used, so the two directions cannot disagree
    // about which spelling a project has — and the gate below re-parses with it too.
    projects: opts && opts.projects,
  });
  const out = lines
    .slice(0, loc.start)
    .concat(region.split('\n'), lines.slice(loc.end + 1))
    .join('\n');
  // The output gate reads `parseAnchoredBlock`, not `TT.parseVaultBlock`: what just came out of
  // the serializer carries both anchors by construction, so an adoption pass here could only
  // ever mask a missing one. The question this gate asks is "would TT's own parser read back
  // what TT just wrote", and adoption is not part of that question.
  if (parseAnchoredBlock(out, opts).quarantine)
    return { md: input, quarantine: true, reason: 'write-would-corrupt', adopted: false };
  return { md: out, quarantine: false, reason: null, adopted };
};

// ---- the catalog note: `Time Turtle/Catalog.md` (SB-058) ----
//
// The one piece of vault state outside the calendar: clients, projects (rates, billable
// defaults, archived flags, `Project.vaultNote`), task templates, and the settings the note
// genuinely owns. FOUR INDEPENDENTLY-ANCHORED SECTIONS, each the same shape as a daily-note
// block, so `TT.locateVaultBlock` parses them unchanged — the catalog is a CONSUMER of the
// locator and modifies nothing about it. Everything outside the four regions is Terje's.
//
// NOT ONE LINE OF FILE I/O IS HERE. Every function takes a string and returns a string or a
// model. Finding, opening and safely replacing the real file is SB-057's.
//
// WHY THIS FILE IS MONOLITHIC when SDD-003 rejected a monolithic mirror for ENTRIES. Not
// convenience — CONTENTION. A single mirror is the worst shape for iCloud because every save
// rewrites the whole file and two machines contend on the same bytes forever, which is why the
// entries shard per day. Clients, projects and rates change MONTHLY, so the odds of two machines
// writing this file inside one sync window are negligible. Low write frequency is the whole
// argument. If the catalog ever becomes a thing that changes several times a day (a per-project
// timer preset, a per-entry rate override written back), the argument expires and this file has
// to shard. "Monolithic is fine" is not a general licence here.
//
// THE MONEY RULES, each one stated as a refusal because each one silently costs money otherwise:
//
//   • WHOLE-CATALOG ATOMICITY, on both sides. One section quarantining quarantines the whole
//     note, and no section is written. `TT.rateOf` resolves project → client → rate, so a
//     catalog that returns projects and silently drops clients makes every rate 0 with no error
//     anywhere. Losing the client/rate catalog is worse than losing a day of entries: refused
//     beats partial. Enforced in `TT.parseVaultCatalog` / `TT.writeVaultCatalog`.
//   • UNKNOWN COLUMN → QUARANTINE. UNKNOWN SETTINGS ROW → CARRIED VERBATIM. The asymmetry is
//     deliberate. A column is a FIELD: dropping one on rewrite loses data with no database
//     behind it to restore from, because under the vault shape this file IS the database. A row
//     is DATA: a settings key from a newer TT has to survive a read-write cycle by an older one,
//     and quarantining on it would freeze the rates over a cosmetic setting. Row-extensible by
//     construction is also what makes SB-044 adding `vaultColumns` purely additive.
//   • A NUMBER THAT CANNOT BE READ IS A REFUSAL, NEVER A VALUE. A `Rate` or `Rounding` cell that
//     does not parse quarantines. It must never become NaN and above all never 0 — a silent 0
//     rate is the failure mode this whole ticket exists to prevent.
//
// TABLES, not the v2 mirror's `- a | b | c` bullet rows, for two independent reasons: the
// locator REQUIRES a header row and a delimiter row, so a bullet list is not locatable at all,
// and SB-058's own bar is "a legitimate reference note Terje would be happy to open" — a rates
// table renders, a bullet list does not.
//
// DD-007 HOLDS: headings and column labels are canonical ENGLISH, never localized. They are
// storage, not UI, exactly as the daily block's headers are.

/**
 * THE SECTION REGISTRY — the ONE home for every heading name, every column label and every
 * per-column codec in this note. SB-106 is the feel-gate on the NAMES (section headings, column
 * labels, whether `Archived` should be a column at all), so a different answer from Terje has to
 * be a one-place change: nothing below reads a literal heading or label, only this table.
 *
 * Each column is `{ label, read, write }` and optionally `when`:
 *   • `read(cell, row)` decodes the STILL-ESCAPED cell onto the row, returning a quarantine
 *     reason or null. Cells arrive escaped because that is what `vaultRowCells` produces, and
 *     structure must be read out of a cell before `TT.decodeCell` collapses the escapes.
 *   • `write(row)` produces the escaped cell.
 *   • `when(rows)` decides whether the column is EMITTED at all. Only `Archived` has one: the
 *     column appears only when at least one row in that table is archived — the emit-when-set
 *     discipline the v2 mirror's ` | archived` token uses, lifted to the column, so a note with
 *     nothing archived carries no column for it.
 *
 * THE READ SIDE ACCEPTS ANY SUBSET IN ANY ORDER, exactly as the daily block does (SB-045's
 * vocabulary rule): a note written before a column existed keeps parsing, and a missing column
 * simply leaves its field at the row default. THE WRITE SIDE EMITS THE CANONICAL SET, which is
 * where the catalog deliberately DIVERGES from `TT.serializeVaultBlock` — that one re-emits the
 * block's own headers. Here the model is complete and the file is the only copy, so echoing a
 * narrower header set would DROP fields that have no database behind them. That is the same
 * data-loss argument the unknown-column rule makes, in the other direction.
 */
const CATALOG_CHECK = BILL_YES; // U+2713 — one check mark in this file, shared with the Bill cell
/**
 * A `Rate` cell. A plain non-negative decimal or nothing at all. No thousands separator, no
 * currency suffix, no sign: those are all shapes a human might type, and every one of them
 * would have to be GUESSED at, which on this column means guessing at money.
 */
const CATALOG_NUMBER_RE = /^\d+(?:\.\d+)?$/;
const CATALOG_ROUNDING_EXACT = 'exact';
/** @param {string} cell @returns {{ value: number | null } | { reason: 'catalog-bad-number' }} */
function readCatalogRate(cell) {
  // An ABSENT rate is a different fact from a rate of 0: it means INHERIT (a project takes its
  // client's rate). `TT.rateOf` depends on that distinction, so an empty cell has to reach the
  // model as null and can never be flattened to 0.
  if (cell === '') return { value: null };
  if (!CATALOG_NUMBER_RE.test(cell)) return { reason: 'catalog-bad-number' };
  return { value: +cell };
}
/** @param {number | null | undefined} rate @returns {string} */
const writeCatalogRate = (rate) => (rate == null ? '' : String(rate));
/**
 * A `Rounding` cell — the word `exact`, or a whole number of minutes.
 *
 * An EMPTY cell reads as `exact` rather than refusing, and this is the one place a blank is
 * given a meaning instead of a refusal. `Rounding` has no null in the model (`Rounding` is
 * `'exact' | number`), and `TT.roundBill` already treats `exact` and 0 identically — so a blank
 * is not an unreadable number, it is an absent one, and the absent value is spelled `exact`. The
 * emitter always writes it out, so a TT-written note never has a blank here to interpret.
 * @param {string} cell @returns {{ value: Rounding } | { reason: 'catalog-bad-number' }}
 */
function readCatalogRounding(cell) {
  if (cell === '' || cell === CATALOG_ROUNDING_EXACT) return { value: CATALOG_ROUNDING_EXACT };
  if (!/^\d+$/.test(cell)) return { reason: 'catalog-bad-number' };
  return { value: +cell };
}
/**
 * `0` emits as `exact`, following the v2 mirror's own `client.rounding || 'exact'`. The two
 * spellings are the same behaviour — `TT.roundBill` reads 0 and `exact` identically — so this
 * normalises a value rather than changing one.
 * @param {Rounding} rounding @returns {string}
 */
const writeCatalogRounding = (rounding) =>
  rounding === CATALOG_ROUNDING_EXACT || !rounding ? CATALOG_ROUNDING_EXACT : String(rounding);
/**
 * A checkmark cell — exactly the check mark, or exactly blank. Anything else is a hand edit
 * whose intent TT cannot know on a column that decides billing or visibility, so it refuses
 * instead of guessing. Same rule as the daily block's `Bill` cell (SB-045).
 * @param {string} cell @returns {{ value: boolean } | { reason: 'catalog-bad-flag-cell' }}
 */
function readCatalogFlag(cell) {
  if (cell === CATALOG_CHECK) return { value: true };
  if (cell === '') return { value: false };
  return { reason: 'catalog-bad-flag-cell' };
}
/** @param {boolean | undefined} on @returns {string} */
const writeCatalogFlag = (on) => (on ? CATALOG_CHECK : '');
/**
 * The Projects table's `Note` column — `Project.vaultNote`, the note this project is written as
 * in a daily-note `Project` cell (SB-059). It goes through `encodeWikilink` / `readWikilink`, the
 * SAME composition the daily-note `Project` cell uses (SB-122), because the field holds the note
 * NAME without them and the two sides must emit identical bytes for identical names.
 *
 * A BARE value (no brackets) is honoured as the note name rather than refused, and re-emitted in
 * canonical `[[…]]` form. Refusing would freeze the whole catalog — and with it every rate — over
 * a missing pair of brackets on a cosmetic column, which is exactly the trade the unknown-settings
 * -row rule already settles in the other direction. No value is lost either way.
 * @param {string} cell still escaped @returns {string | undefined}
 */
function readCatalogNote(cell) {
  if (cell === '') return undefined;
  const note = readWikilink(cell);
  return note === null ? TT.decodeCell(cell) : note;
}
/** @param {string | undefined} note @returns {string} */
const writeCatalogNote = (note) => (note ? encodeWikilink(note) : '');

/** @type {Record<string, import('./types.ts').VaultCatalogSectionName>} */
const CATALOG_SECTION_NAMES = { clients: 'clients', projects: 'projects', tasks: 'tasks', settings: 'settings' };
/**
 * @typedef {{
 *   label: string,
 *   id?: string,
 *   when?: (rows: any[]) => boolean,
 *   read: (cell: string, row: any) => import('./types.ts').VaultQuarantineReason | null,
 *   write: (row: any) => string,
 * }} CatalogColumn
 */
/**
 * Column FACTORIES. Every column in this registry is one of four shapes, and each shape is built
 * here exactly once — so a rule added to a column type reaches every column of that type instead
 * of reaching the copy that happened to be edited.
 *
 * That is not cosmetic on this file. `Rate` and `Archived` each appeared as a byte-identical
 * literal in BOTH money tables, which is a live drift path: a guard tightened on the Clients copy
 * and not the Projects one is a rule that silently holds for half the money.
 *
 * `codec` is the read half's `{ value } | { reason }` pair — the one place the refusal is
 * unwrapped, so no column can forget to propagate one.
 * @param {string} label @param {string} field @param {{ id?: boolean }} [opts] @returns {CatalogColumn}
 */
const catalogTextColumn = (label, field, opts) => ({
  label,
  ...(opts && opts.id ? { id: field } : {}),
  read: (cell, row) => ((row[field] = TT.decodeCell(cell)), null),
  write: (row) => TT.encodeCell(row[field]),
});
/**
 * A column whose codec can REFUSE. The `'reason' in read` unwrap lives here and nowhere else.
 * @param {string} label @param {string} field
 * @param {(cell: string) => any} decode @param {(value: any) => string} encode
 * @param {{ when?: (rows: any[]) => boolean }} [opts] @returns {CatalogColumn}
 */
const catalogCodecColumn = (label, field, decode, encode, opts) => ({
  label,
  ...(opts && opts.when ? { when: opts.when } : {}),
  read: (cell, row) => {
    const read = decode(cell);
    if ('reason' in read) return read.reason;
    row[field] = read.value;
    return null;
  },
  write: (row) => encode(row[field]),
});
/** The `Rate` column, shared by both money tables — ONE definition, not one per table. */
const catalogRateColumn = () => catalogCodecColumn('Rate', 'rate', readCatalogRate, writeCatalogRate);
/**
 * The `Archived` column, shared by both money tables. Emit-when-set is part of the column's own
 * definition, so the two tables cannot disagree about when it appears.
 */
const catalogArchivedColumn = () =>
  catalogCodecColumn('Archived', 'archived', readCatalogFlag, writeCatalogFlag, {
    when: (rows) => rows.some((row) => row.archived),
  });

/** @type {Record<string, { heading: string, blank: () => any, columns: CatalogColumn[] }>} */
const CATALOG_SECTIONS = {
  // THE MONEY TABLE. `Client` is the id the Projects table's `Client` column points at, so a
  // change to either label moves a reference, not just a word.
  clients: {
    heading: 'Clients',
    blank: () => /** @type {Client} */ ({ id: '', name: '', rate: null, rounding: CATALOG_ROUNDING_EXACT, archived: false }), // prettier-ignore
    columns: [
      catalogTextColumn('Client', 'id', { id: true }),
      catalogTextColumn('Name', 'name'),
      catalogRateColumn(),
      catalogCodecColumn('Rounding', 'rounding', readCatalogRounding, writeCatalogRounding),
      catalogArchivedColumn(),
    ],
  },
  // The other money table, and the home `Project.vaultNote` never had. SB-059 added the field and
  // its wikilink rendering, then SB-069 froze the v2 mirror — so until this column existed the
  // field survived no round-trip anywhere.
  projects: {
    heading: 'Projects',
    blank: () => /** @type {Project} */ ({ code: '', name: '', clientId: null, rate: null, billable: false, archived: false }), // prettier-ignore
    columns: [
      catalogTextColumn('Project', 'code', { id: true }),
      catalogTextColumn('Name', 'name'),
      {
        label: 'Client',
        // An ABSENT client cell is `clientId: null` — a project with no client. Deliberately NOT
        // the v2 mirror's `—` placeholder: SB-045 ruled `—` out of the vault format, and inside a
        // table an empty cell is already unambiguous. Not `catalogTextColumn`, which would store
        // '' and make "no client" and "a client named nothing" the same value.
        read: (cell, row) => ((row.clientId = cell === '' ? null : TT.decodeCell(cell)), null),
        write: (row) => (row.clientId ? TT.encodeCell(row.clientId) : ''),
      },
      catalogRateColumn(),
      // `✓`/blank exactly as the daily block's `Bill` is. Note the row default is FALSE, not the
      // model's "billable unless someone says otherwise": inside a note the cell is explicit, and
      // a Projects table written with no `Billable` column at all is one where nothing said yes.
      catalogCodecColumn('Billable', 'billable', readCatalogFlag, writeCatalogFlag),
      {
        label: 'Note',
        read: (cell, row) => {
          const note = readCatalogNote(cell);
          if (note !== undefined) row.vaultNote = note;
          return null;
        },
        write: (row) => writeCatalogNote(row.vaultNote),
      },
      catalogArchivedColumn(),
    ],
  },
  // Per-user templates (SDD-002) in a note that is a PERSONAL-shape artifact — and personal
  // implies exactly one user (SDD-003's single-user guard, DD-015), so one templates table is
  // well defined here in a way it would not be under the team shape.
  //
  // STRAIGHT `TT.encodeCell` CELLS, and nothing else. `<br>` and the `- ` prefix are structural
  // ONLY in the daily block's `Task` cell (SB-045, DD-010), where a label and a note share one
  // cell; a template has a label and no note, so importing `encodeTaskCell` here by reflex would
  // put a backslash in front of a label that legitimately starts with `- ` and escape a `<br>`
  // that has no delimiter to collide with.
  tasks: {
    heading: 'Task templates',
    blank: () => /** @type {Task} */ ({ id: '', label: '', project: null }),
    columns: [
      catalogTextColumn('Template', 'id', { id: true }),
      catalogTextColumn('Label', 'label'),
      // A template's project is a CODE, not a wikilink: `Task.project` holds the code and the
      // daily block's wikilink rendering is a property of an ENTRY's cell (SB-059), not of every
      // column that happens to name a project.
      //
      // A code naming no project is CARRIED, not refused — deliberately unlike a project's
      // dangling clientId. A template is a stamp: logging an hour COPIES its label and project
      // onto the entry (SDD-002), and no resolver reads money through it, so a stale template
      // costs one bad autofill rather than a rate of 0. Refusing would also make deleting a
      // project quarantine the file that holds the rates.
      { label: 'Project', read: (cell, row) => ((row.project = cell === '' ? null : TT.decodeCell(cell)), null), write: (row) => (row.project ? TT.encodeCell(row.project) : '') }, // prettier-ignore
    ],
  },
  // THE SETTINGS THE NOTE ACTUALLY OWNS — and the exclusion that is a correctness rule rather
  // than a preference.
  //
  // FOUR SETTINGS STAY IN SQLITE UNDER BOTH SHAPES and must never be serialized here. Three of
  // them — `shape` (`backend` before SB-100), `vaultPaths` and `mdDir` — are how TT FINDS this
  // note, so putting them in it is a bootstrap loop. `vaultCutover` joins them under DD-017: it
  // means "the date THIS instance's vault history begins", which is per-instance by definition.
  // The exclusion is proved by a test asserting on BOTH spellings of the renamed axis, so it
  // cannot go quietly green.
  //
  // AN UNKNOWN KEY IS CARRIED VERBATIM AND RE-EMITTED — not applied, and not quarantined. That
  // is the exact opposite of the unknown-COLUMN rule above, and deliberately so. A row is
  // extensible by construction and a column is not: a settings key written by a NEWER TT must
  // survive a read-write cycle by an OLDER one, and quarantining on it would freeze the file
  // that holds the rates over a cosmetic setting. It is also what makes SB-044's `vaultColumns`
  // purely additive whenever it lands — no format change, no migration.
  //
  // The rows are therefore the single source of truth for the bytes, IN NOTE ORDER, and
  // `TT.vaultCatalogSettings` is the typed projection of the keys this TT understands. One
  // source, one order, no second copy that can drift.
  settings: {
    heading: 'Settings',
    blank: () => /** @type {import('./types.ts').VaultCatalogSettingRow} */ ({ key: '', value: '' }),
    columns: [catalogTextColumn('Setting', 'key', { id: true }), catalogTextColumn('Value', 'value')],
  },
};

/**
 * The section's canonical header labels for a given set of rows — every column whose `when` says
 * it applies. ONE definition, so the emitter and anything reasoning about the header set cannot
 * drift about whether `Archived` is there.
 * @param {{ columns: CatalogColumn[] }} spec @param {any[]} rows @returns {CatalogColumn[]}
 */
const catalogColumnsFor = (spec, rows) => spec.columns.filter((column) => !column.when || column.when(rows));

/**
 * THE ANCHOR EMITTER for a catalog section — one of exactly TWO places in this file that decide
 * how the catalog's revision counter reaches and leaves the bytes (the reader is
 * `catalogRevisionOf`). SB-104 is open on WHICH counter a per-file arbiter compares, and this
 * pair is why the ruling is a one-place change: under both live options the sections each carry a
 * revision line and the bytes are identical, and only the BUMP rule differs — which lives in
 * SB-057's arbitration, not here.
 *
 * Delegates the line itself to `vaultRevisionLine` and the digest to `vaultPayloadDigest`, the
 * daily block's sole emitter and sole hash. DD-009's digest is PER BLOCK, and that is decisive
 * here rather than incidental: one file-level revision line spanning four tables would leave the
 * Projects table with no digest of its own, so an Obsidian diff-merge (SB-051) that rewrites a
 * RATE would be undetectable. On the one file where a silent rewrite costs money, the per-section
 * digest is the reason the format looks like this.
 *
 * @param {import('./types.ts').VaultCatalogSectionName} section
 * @param {any[]} rows
 * @param {{ revision?: number }} [opts]
 * @returns {string} the region bytes — `## <Heading>` through the revision line, no trailing newline
 */
TT.serializeVaultCatalogSection = function (section, rows, opts) {
  const spec = CATALOG_SECTIONS[section];
  const list = rows || [];
  const columns = catalogColumnsFor(spec, list);
  const revision = opts && opts.revision != null ? opts.revision : 1; // a first write starts at 1
  const labels = columns.map((column) => column.label);
  // Cells first, then one aligned emission — same reason as the daily block (DD-023 half 1): the
  // column widths are not known until the last row is in hand. The catalog gets half 1 too
  // because Obsidian re-pads whichever table is edited, and this is the one file where a silent
  // rewrite costs money.
  const cellRows = [labels];
  for (const row of list) cellRows.push(columns.map((column) => column.write(row)));
  const lines = ['## ' + spec.heading, ''].concat(vaultAlignedTable(cellRows));
  // No totals row: the daily block's exists because a day has hours to add up, and this table has
  // nothing to total. `lines.slice(2)` is therefore exactly the payload the digest covers —
  // header, delimiter, data rows — taken before the blank line and the anchor are appended.
  lines.push('', vaultRevisionLine(revision, vaultPayloadDigest(lines.slice(2))));
  return lines.join('\n');
};

/**
 * Parse ONE catalog section out of a note, or refuse. Locates with the SHARED
 * `TT.locateVaultBlock` — same anchors, same hard stop at the next heading, same per-table
 * digest — and then reads the table through the section registry.
 *
 * The whole-note entry point is `TT.parseVaultCatalog`, which is what enforces whole-catalog
 * atomicity and the cross-section rules. This one is exposed because each half has to be
 * testable on its own, and because SB-057 reporting "the Projects section is quarantined" is
 * more use to a human than "the catalog is quarantined".
 *
 * @param {string} md @param {import('./types.ts').VaultCatalogSectionName} section
 * @returns {import('./types.ts').VaultCatalogSectionResult}
 */
TT.parseVaultCatalogSection = function (md, section) {
  // `hasOwnProperty`, not a truthiness test on the lookup: `CATALOG_SECTIONS['__proto__']` resolves
  // to `Object.prototype`, which is TRUTHY and has no `heading` — so a bare `if (!spec)` would let
  // that one name through to report `no-heading` about a section that does not exist. An untrusted
  // string really does take that shape, which is the whole reason this check is here.
  const spec = Object.prototype.hasOwnProperty.call(CATALOG_SECTIONS, section) ? CATALOG_SECTIONS[section] : null;
  // SB-124: REFUSE, DO NOT THROW. Every other vault codec here is documented as never throwing —
  // it returns a verdict, because SB-083's posture is "TT refuses, but it says why" and a refusal
  // a caller can inspect is the mechanism that makes that true. A throw is not a refusal: it skips
  // the quarantine reporting entirely and hands a human a stack trace, or a dead boot scan, instead
  // of a line explaining what TT could not read.
  //
  // The TYPE guards TypeScript callers and stays — but `server/src/` is plain JS, and SB-057's sync
  // engine is the first caller that hands this function a section name derived from a note a HUMAN
  // typed rather than a typed literal. That is exactly the untrusted-input direction the type
  // system does not defend. Before this, an unknown name reached `spec.heading` on `undefined`.
  if (!spec) return { quarantine: true, reason: 'catalog-unknown-section', section };
  const loc = TT.locateVaultBlock(md, { heading: spec.heading });
  // propagated UNCHANGED, plus the section name — the locator owns its reasons, and a shared
  // reason like 'no-heading' only becomes actionable once you know WHICH heading
  if (loc.quarantine) return { quarantine: true, reason: loc.reason, section };
  const lines = String(md == null ? '' : md).split('\n');

  // the header row IS the schema (SB-045), read against this section's vocabulary
  const headers = vaultRowCells(lines[loc.headerLine]);
  /** @type {CatalogColumn[]} */
  const columns = [];
  for (const label of headers) {
    const key = label.toLowerCase();
    const column = spec.columns.find((candidate) => candidate.label.toLowerCase() === key);
    // UNKNOWN COLUMN → QUARANTINE. A column is a field, and dropping one on rewrite is data loss
    // with no database behind it to restore from. See the header comment for the row/column
    // asymmetry this is one half of.
    if (!column) return { quarantine: true, reason: 'unknown-header', section };
    if (columns.includes(column)) return { quarantine: true, reason: 'duplicate-header', section };
    columns.push(column);
  }
  // The identity column names the model field it fills, so "which cell is the id" and "which
  // field is the id" are ONE fact. Held apart they typecheck independently (rows are `any` across
  // four model types), and a rename of one would make `row[idField]` undefined — the blank-id
  // refusal would stop firing and every row would collide on `undefined`, quarantining the
  // section as a duplicate-id for entirely the wrong reason.
  const idColumn = spec.columns.find((column) => column.id);
  const idField = idColumn ? idColumn.id : '';
  // A section with no id column declared cannot produce a referenceable row at all. Reported as
  // the row-level fact rather than as a header problem, because that is what it costs.
  if (idColumn && !columns.includes(idColumn)) return { quarantine: true, reason: 'catalog-missing-id', section };

  /** @type {any[]} */
  const rows = [];
  const seen = new Set();
  for (const ln of loc.rowLines) {
    const cells = vaultRowCells(lines[ln]);
    if (cells.length !== columns.length) return { quarantine: true, reason: 'row-cell-count', section };
    const row = spec.blank();
    for (let c = 0; c < columns.length; c++) {
      const reason = columns[c].read(cells[c], row);
      if (reason) return { quarantine: true, reason, section };
    }
    if (idField) {
      const id = row[idField];
      // A row with no identity can be neither referenced nor rewritten, and dropping it silently
      // is how a client disappears out of the file that resolves the rates.
      if (id === '') return { quarantine: true, reason: 'catalog-missing-id', section };
      // Under the vault shape there is no database uniqueness constraint behind this file, so the
      // parse is the only place a duplicate can be caught. Resolution takes the FIRST match
      // (`TT.projectOf`, `TT.clientOf`), which would make the second row invisible rather than
      // visibly wrong — the quiet direction, and therefore the one to refuse.
      if (seen.has(id)) return { quarantine: true, reason: 'catalog-duplicate-id', section };
      seen.add(id);
    }
    rows.push(row);
  }

  return {
    quarantine: false,
    section,
    heading: loc.heading,
    revision: loc.revision,
    headers,
    rows,
    verified: loc.verified,
  };
};

/**
 * The settings keys the catalog note carries, and the ONLY ones it may.
 *
 * `currency` and `language` are free text (`putSettings` writes them as given).
 * `vaultTimeSeparator` is an ENUM, validated against `TT.TIME_SEPARATOR_VALUES` — the one home
 * of that vocabulary — because an unrecognised value would read back as junk even though
 * `TT.timeSeparator` would safely emit the default for it.
 * @type {Record<string, (value: string) => boolean>}
 */
const CATALOG_SETTING_KEYS = {
  currency: () => true,
  language: () => true,
  vaultTimeSeparator: (value) => TT.TIME_SEPARATOR_VALUES.includes(value),
};
/**
 * The settings keys the catalog note carries, as a list. The ONE home of that vocabulary, the way
 * `TT.SHAPES` and `TT.TIME_SEPARATOR_VALUES` are the one home of theirs.
 *
 * What is NOT on it is the load-bearing half, and it is an allowlist rather than a denylist on
 * purpose: `shape` (`backend` before SB-100), `vaultPaths`, `mdDir` and `vaultCutover` stay in
 * SQLite under both shapes, and an allowlist means a settings key invented later is excluded by
 * default instead of included by omission.
 */
TT.VAULT_CATALOG_SETTING_KEYS = Object.keys(CATALOG_SETTING_KEYS);
/**
 * The typed projection of a catalog's settings rows — the keys this TT understands, with a value
 * it is willing to apply. Everything else stays on the rows and is re-emitted untouched.
 *
 * An unrecognised value for a known ENUM key is DROPPED here rather than refused, which is
 * exactly what `putSettings` does with the same value (`server/src/db.js`): it writes only what
 * it recognises and silently ignores the rest. One rule, in both directions — and the row itself
 * survives, so an older TT reading a newer TT's value never rewrites it away.
 * @param {import('./types.ts').VaultCatalogSettingRow[]} rows @returns {Partial<Settings>}
 */
TT.vaultCatalogSettings = function (rows) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const row of rows || []) {
    const validate = CATALOG_SETTING_KEYS[row.key];
    if (validate && validate(row.value)) out[row.key] = row.value;
  }
  return /** @type {Partial<Settings>} */ (out);
};
/**
 * The settings rows a catalog note should carry for a given settings object — every key the note
 * OWNS that is actually set, in the registry's canonical order, followed by the rows this TT did
 * not recognise, in the order the note carried them.
 *
 * THE INSTANCE-LOCAL EXCLUSION IS ENFORCED HERE, AND THE SCOPE OF THAT IS EXACTLY ONE FUNCTION —
 * this one. A `Settings` object handed to it cannot put `shape`, `vaultPaths`, `mdDir` or
 * `vaultCutover` into the note, because the keys are taken from `CATALOG_SETTING_KEYS` rather than
 * from the object.
 *
 * IT IS NOT A BYTE-BOUNDARY GUARANTEE, and an earlier version of this comment wrongly claimed it
 * was ("cannot reach the note however it is passed in"). `serializeVaultCatalog` and
 * `writeVaultCatalog` take settings ROWS, and they emit the rows they are given — which they must,
 * because the unknown-row rule requires a key from a newer TT to survive a read-write cycle
 * untouched, and a filter at the byte boundary could not tell that key from a forbidden one. So a
 * caller that builds rows itself, out of `Object.entries(settings)`, WILL write `vaultPaths` into
 * the synced note.
 *
 * The rule is therefore: **build the rows here.** SB-057, that means you — the bootstrap loop this
 * exclusion prevents is reachable only by going around this function.
 *
 * The read direction has no such hole: `TT.vaultCatalogSettings` projects only allowlisted keys,
 * so a forbidden row that is already in a note is carried verbatim (Terje's bytes are his) and can
 * never be applied.
 * @param {Partial<Settings>} settings
 * @param {import('./types.ts').VaultCatalogSettingRow[]} [carried] rows from a previous parse
 * @returns {import('./types.ts').VaultCatalogSettingRow[]}
 */
TT.vaultCatalogSettingRows = function (settings, carried) {
  /** @type {import('./types.ts').VaultCatalogSettingRow[]} */
  const rows = [];
  for (const key of Object.keys(CATALOG_SETTING_KEYS)) {
    const value = settings ? /** @type {Record<string, unknown>} */ (settings)[key] : undefined;
    if (value != null && value !== '') rows.push({ key, value: String(value) });
  }
  for (const row of carried || []) if (!CATALOG_SETTING_KEYS[row.key]) rows.push({ ...row });
  return rows;
};

// ---- the whole note: assemble, splice, and refuse as one unit ----
//
// WHOLE-CATALOG ATOMICITY IS THE POINT OF THIS LAYER. If any single section quarantines,
// `parseVaultCatalog` returns a quarantine naming the section and the reason, and
// `writeVaultCatalog` writes NO section and hands the note back byte-identical.
//
// The reason is `TT.rateOf`, which resolves project → client → rate. A catalog that returned
// projects and silently dropped clients would make every rate 0, with no error anywhere and
// nothing on screen — an invoice for free work. Losing the client/rate catalog is worse than
// losing a day of entries, so refused beats partial, in both directions.
//
// NO ADOPTION HERE (DD-012 is deliberately not extended to this note). The daily note needs
// adoption because Terje hand-writes daily notes; the catalog is a file TT owns end to end, and a
// `## Clients` heading in some unrelated note is not an invitation to claim it. A missing section
// is reported as a missing section — whether to CREATE the note is a write decision, and it is
// SB-057's, with the bytes already available from `TT.serializeVaultCatalog`.
/**
 * The sections, in the order a NEW note is written. An EXISTING note keeps its own order: the
 * splice puts each section back where it was, so rearranging the note is Terje's to do.
 * @type {import('./types.ts').VaultCatalogSectionName[]}
 */
const CATALOG_ORDER = [
  CATALOG_SECTION_NAMES.clients,
  CATALOG_SECTION_NAMES.projects,
  CATALOG_SECTION_NAMES.tasks,
  CATALOG_SECTION_NAMES.settings,
];
/**
 * The H1 a note TT creates from scratch opens with. In the registry with everything else SB-106
 * gates, because whether the note wants a title at all is a taste question and not a parse one —
 * nothing reads it, the locator's hard stop is unaffected by it, and a note that does not have it
 * parses exactly the same.
 */
const CATALOG_TITLE = '# Time Turtle';

/**
 * THE ANCHOR READER — the other of the two places that decide how the catalog's revision counter
 * crosses the bytes (the emitter is `TT.serializeVaultCatalogSection`). SB-104 is open on which
 * counter a per-file arbiter compares, and this function is where a different ruling lands: today
 * it demands agreement, and "the file takes the max" would be a one-line change here.
 *
 * DISAGREEMENT IS A QUARANTINE, NOT A MAXIMUM. A TT-written catalog cannot carry mixed revisions —
 * TT writes the note whole, one file, one atomic rename (SB-057's write primitive) — so mixed
 * revisions mean a merge or a partial hand edit. Reconciling to the max would silently adopt
 * whichever half won, on the file that holds the rates.
 *
 * The counter is NOT bumped anywhere in this file. When a write bumps it is SB-057's arbitration
 * to rule on, exactly as `TT.writeVaultBlock` leaves it.
 * @param {import('./types.ts').VaultCatalogSectionParse[]} sections
 * @returns {{ revision: number } | { reason: 'catalog-revision-mismatch' }}
 */
function catalogRevisionOf(sections) {
  const revision = sections.length ? sections[0].revision : 1;
  for (const section of sections) if (section.revision !== revision) return { reason: 'catalog-revision-mismatch' };
  return { revision };
}

/**
 * Serialize a whole catalog note — the bytes of a note that does not exist yet. SB-057 needs
 * exactly this for the first-boot case: producing the bytes is here, writing them is there.
 *
 * `catalog.settings` is the ROWS (see `TT.vaultCatalogSettingRows`), not a `Settings` object, so
 * that the keys this TT does not know survive whatever the caller does with the typed half.
 * @param {{ clients?: Client[], projects?: Project[], tasks?: Task[], settings?: import('./types.ts').VaultCatalogSettingRow[], revision?: number }} catalog
 * @param {{ revision?: number }} [opts]
 * @returns {string}
 */
TT.serializeVaultCatalog = function (catalog, opts) {
  const source = catalog || {};
  const revision = (opts && opts.revision != null ? opts.revision : source.revision) ?? 1;
  const lines = [CATALOG_TITLE, ''];
  for (const section of CATALOG_ORDER) {
    // THE SAME N INTO EVERY SECTION. One catalog-wide counter, written identically four times —
    // the catalog is the unit of change and the section is not.
    // `|| []` is right HERE and wrong in `writeVaultCatalog`: this composes a note that does not
    // exist yet, so a section the caller did not supply is genuinely empty. There is no prior
    // content for an absent key to mean "leave alone".
    lines.push(TT.serializeVaultCatalogSection(section, source[section] || [], { revision }), '');
  }
  return lines.join('\n');
};

/**
 * Parse a whole catalog note into a model, or refuse — as ONE unit. Any section quarantining
 * quarantines the note.
 * @param {string} md @returns {import('./types.ts').VaultCatalogParseResult}
 */
TT.parseVaultCatalog = function (md) {
  const input = String(md == null ? '' : md);
  /** @type {import('./types.ts').VaultCatalogSectionParse[]} */
  const sections = [];
  for (const section of CATALOG_ORDER) {
    const parsed = TT.parseVaultCatalogSection(input, section);
    if (parsed.quarantine) return parsed; // named, with its section — no partial catalog escapes
    sections.push(parsed);
  }
  // structural first: a revision disagreement is a fact about the NOTE, and diagnosing a
  // dangling reference inside a note that has plainly been merged would name the wrong problem
  const counter = catalogRevisionOf(sections);
  if ('reason' in counter) return { quarantine: true, reason: counter.reason, section: null };

  // Looked up BY NAME, never by position. `CATALOG_ORDER` is the order a new note is WRITTEN in —
  // a presentation choice SB-106 gates — and positional destructuring would silently swap clients
  // and projects the day that list is reordered: the dangling-client check would then scan the
  // wrong table, and not one BYTE golden would notice.
  /** @param {import('./types.ts').VaultCatalogSectionName} name @returns {any[]} */
  const rowsOf = (name) => {
    const found = sections.find((section) => section.section === name);
    // unreachable: `sections` was just filled from CATALOG_ORDER, which is these four names. The
    // narrowing is the point — a section added to the type without being added to CATALOG_ORDER
    // should stop here rather than hand back an undefined table.
    if (!found) throw new Error('catalog section not parsed: ' + name);
    return found.rows;
  };
  const clients = /** @type {Client[]} */ (rowsOf(CATALOG_SECTION_NAMES.clients));
  const projects = /** @type {Project[]} */ (rowsOf(CATALOG_SECTION_NAMES.projects));
  // THE CROSS-SECTION RULE, and the one this whole ticket exists for. A `Project.clientId` naming
  // a client the Clients table does not contain round-trips PERFECTLY — the bytes are identical
  // both ways — while `TT.rateOf` returns 0 for every project on that client. SB-048 taught this
  // exact blindness the expensive way (a byte-green mirror golden beside a `commitSnapshot` that
  // returned null), and byte equality is structurally incapable of seeing it.
  //
  // A DECISION, not a fall-through: it QUARANTINES. Under the vault shape there is no database to
  // reconcile a dangling id against — this file IS the database — so the only alternatives are
  // resolving to 0 (an invoice for free work) or dropping the reference (the same, silently). A
  // dangling clientId is a catalog a human has to look at.
  const ids = new Set(clients.map((client) => client.id));
  for (const project of projects)
    if (project.clientId && !ids.has(project.clientId))
      return { quarantine: true, reason: 'catalog-dangling-client', section: CATALOG_SECTION_NAMES.projects };

  return {
    quarantine: false,
    clients,
    projects,
    tasks: /** @type {Task[]} */ (rowsOf(CATALOG_SECTION_NAMES.tasks)),
    settings: /** @type {import('./types.ts').VaultCatalogSettingRow[]} */ (rowsOf(CATALOG_SECTION_NAMES.settings)),
    revision: counter.revision,
    // one unverified section leaves the NOTE unverified: the catalog is the unit of change, so a
    // partly-verified catalog is not a thing SB-057's arbitration should be offered
    verified: sections.every((section) => section.verified),
  };
};

/**
 * Write a catalog into an existing note, leaving every byte outside the four regions untouched —
 * an H1, prose above the first section, notes between sections, anything below the last one.
 * The same guarantee `TT.writeVaultBlock` gives a daily note.
 *
 * THE GATE IS THE PARSER, NOT JUST THE LOCATOR, and it runs on both sides:
 *   • the INPUT is parsed whole, so it is impossible to reach a write from a note TT cannot read.
 *     A quarantined catalog is left exactly as it is for a human to resolve (SB-057's surface),
 *     which is also why "fix the dangling client by writing over it" is deliberately not a path.
 *   • the OUTPUT is parsed back before it is returned — the lesson PLAN-009's end-gate review
 *     paid for. Anything that would not survive the round-trip is refused as `write-would-corrupt`
 *     with the input handed back untouched, rather than reported as a successful write that froze
 *     the note against TT until a human repaired it by hand.
 *
 * The revision is NOT bumped here: `opts.revision` sets it, and absent, the note's own counter is
 * re-emitted unchanged. When a write bumps it is SB-057's arbitration.
 * @param {string} md @param {{ clients?: Client[], projects?: Project[], tasks?: Task[], settings?: import('./types.ts').VaultCatalogSettingRow[], revision?: number }} catalog
 * @param {{ revision?: number }} [opts]
 * @returns {import('./types.ts').VaultCatalogWriteResult}
 */
TT.writeVaultCatalog = function (md, catalog, opts) {
  const input = String(md == null ? '' : md);
  const source = catalog || {};
  const parsed = TT.parseVaultCatalog(input);
  if (parsed.quarantine) return { md: input, quarantine: true, reason: parsed.reason, section: parsed.section };
  const revision = (opts && opts.revision != null ? opts.revision : source.revision) ?? parsed.revision;

  // Re-locating is not redundant: the parse returns values, not line offsets. Collected for ALL
  // four sections BEFORE anything is spliced, because a locate that failed halfway through would
  // otherwise leave the note with two sections rewritten and two not — the partial write this
  // whole layer exists to make impossible.
  const lines = input.split('\n');
  /** @type {{ start: number, end: number, region: string }[]} */
  const splices = [];
  for (const section of CATALOG_ORDER) {
    const loc = TT.locateVaultBlock(input, { heading: CATALOG_SECTIONS[section].heading });
    if (loc.quarantine) return { md: input, quarantine: true, reason: loc.reason, section };
    splices.push({
      start: loc.start,
      end: loc.end,
      // AN ABSENT SECTION KEEPS THE NOTE'S OWN ROWS. `??` and not `||`, so the two cases stay
      // distinguishable: an explicit `[]` still empties the section, and a MISSING key means "I am
      // not changing this one".
      //
      // This is the atomicity rule arriving through the write direction, and it was a real defect
      // caught by the end-gate review: with `|| []`, `writeVaultCatalog(note, { clients })` — the
      // exact call a `Partial<VaultCatalog>` signature invites — returned `quarantine: false` and
      // a note whose Projects, Task templates and Settings tables had been emptied. The output
      // gate cannot see it, because a header-only table parses perfectly well. That is the same
      // "keeps its clients, loses its projects, every rate resolves to 0" failure this whole layer
      // is written about, reported as a successful write, on the file that IS the database.
      region: TT.serializeVaultCatalogSection(section, source[section] ?? parsed[section], { revision }),
    });
  }
  // BOTTOM-UP, by the position the section actually occupies in THIS note — so a note whose
  // author put Settings first keeps that order, and every splice's offsets stay valid because
  // nothing below it has moved yet. The regions cannot overlap: each one ends at its own revision
  // line, which the locator already proved sits before the next heading of any level.
  let out = lines;
  for (const splice of splices.slice().sort((a, b) => b.start - a.start))
    out = out.slice(0, splice.start).concat(splice.region.split('\n'), out.slice(splice.end + 1));
  const written = out.join('\n');

  // The REASON stays `write-would-corrupt` — that is the class, and SB-057 keys on it — but the
  // SECTION comes from the failed read, because "TT could not read back what it just wrote" is
  // not a diagnosis anyone can act on without knowing which table it was. A caller handing in a
  // dangling `clientId` lands here rather than on `catalog-dangling-client`, and the section name
  // is what makes those two distinguishable on the surface.
  const gate = TT.parseVaultCatalog(written);
  if (gate.quarantine) return { md: input, quarantine: true, reason: 'write-would-corrupt', section: gate.section };
  return { md: written, quarantine: false, reason: null, section: null };
};

// ---- canonical row string (DD-008 spec obligation — nothing computes this in phase 1) ----
// Phase 1 computes and stores nothing. Committing is off in the `personal` shape under phase 1+2, so the
// derived persistence key has no consumer yet and no code in PLAN-009 produces one. What phase 1 owes is
// this spec, because it is cheap now and expensive to retrofit: phase 3 computes the key from it, and if
// the string is undefined until then, phase 3 has to invent it against a year of already-written notes.
//
// DD-008's two identity layers stand: the runtime id (`nid()`) is EPHEMERAL — a per-parse in-memory
// handle for the React key and the mutation match — and must never reach disk. The persistence
// identity is a digest over the canonical row string defined below, plus an ordinal when two rows on one
// day are identical.
//
// Every rule is stated in terms of what `TT.serializeVaultBlock` / `TT.parseVaultBlock` actually do as of
// PLAN-009, not aspirationally.
//
// --- 1. The digest is over PARSED VALUES, not over the cell bytes
//
// Two consequences, both load-bearing:
//
// - SB-041's escaping drops out. A field holding `a|b` digests identically whether it reached disk as
//   `a\|b` or was hand-typed some other way, so the key does not depend on escaping choices.
// - The emitted separator drops out. SB-063 LANDED: `Settings.vaultTimeSeparator` chooses which of
//   `→` (default) / `->` / `-` the vault block writes, so that setting now flips in the field. A
//   separator-dependent digest would re-key every row in the vault the day it does.
//
// --- 2. Fixed field order, independent of the block's header order
//
// ```
// 1  date
// 2  time
// 3  mode
// 4  project
// 5  label
// 6  note
// 7  billable
// 8+ any FURTHER vocabulary columns, in the vocabulary's canonical order
// ```
//
// This mirrors SB-045's column order (`Time · Mode · Project · Task · Bill`) with the date prepended and
// `Task` expanded into its two fields. It is the vocabulary's order, never the block's header order —
// reordering the header row must not re-key a single row, and TT already parses any subset in any order.
//
// --- 3. The join
//
// Fields are joined with U+001F (UNIT SEPARATOR) and the digest is taken over the UTF-8 bytes of the
// result. A markdown table cell cannot carry U+001F through TT's parser, so the join stays unambiguous
// even with empty fields present — which is precisely why rule 5 needs no placeholder.
//
// --- 4. Time normalization — the three legal shapes, plus the empty cell
//
// ```
// range     → range:<startMin>-<endMin>      e.g. range:540-930
// running   → running:<startMin>             e.g. running:1054
// duration  → duration:<min>                 e.g. duration:30
// empty     → none
// ```
//
// Minutes since midnight, as decimal integers. The separator is not part of it. `09:00-15:30`,
// `09:00→15:30` and `09:00->15:30` are the same row — `TT.parseTimeCell` already accepts all three — so
// the digest must not be able to tell them apart.
//
// *Consequence, recorded not decided:* stopping a running timer changes the row's key
// (`running:1054` → `range:1054-1080`). A content-derived identity is not stable under edit. See rule 11.
//
// --- 5. Empty cells are the empty string — no placeholder
//
// The vault emits `''` for a null project, `''` for an empty `Task` and `''` for a non-billable `Bill`.
// `—` is explicitly not part of this format (SB-045: `Bill` is `✓` or blank, not `—`), unlike the v2
// mirror where `—` marks an absent project. Rule 3's separator makes an empty field unambiguous, so a
// placeholder would only invent a token a user could also type.
//
// --- 6. `- ` and `<br>` never appear in the string
//
// Both are presentation (SB-045 consequence 7): `<br>` is the structural delimiter between label and note,
// `- ` is the note's bullet prefix, and `TT.decodeTaskCell` strips both on import. The digest sees `label`
// and `note` as two separate fields, so there is nothing to strip at digest time — this falls out of the
// field order rather than being a normalization step.
//
// --- 7. Billable is `1` or `0`
//
// Note the asymmetry TT already implements: a block with no `Bill` column at all parses to
// `billable = true` (billable unless something says otherwise), so it digests as `1`, not as absent.
//
// --- 8. Passthrough columns
//
// A vocabulary column TT has no model field for is carried raw on `entry.vaultCells` and re-emitted
// verbatim. In the canonical string it is decoded, and it occupies its fixed slot — `mode` is
// field 3 whether it arrives from the passthrough (phase 1) or from `Entry.tags` (SB-059). Pinning the
// slot today is the whole point: SB-059 giving `Mode` a model field must not move it in the string.
//
// SB-059 HAS SINCE LANDED, and the slot held: field 3 is `TT.encodeTagsCell(entry.tags)` DECODED —
// i.e. the tags space-joined, `#` included, which is the same string the passthrough produced for the
// same cell. `#deep` keyed as `#deep` before and keys as `#deep` now. That is not an accident of
// storing the `#`; it is why the tokens are stored verbatim (see `Entry.tags` in types.ts).
//
// A column the block does not declare contributes the empty string, so a pre-`Mode` 4-column block and a
// 5-column block with a blank `Mode` key identically. Any column SB-044 adds beyond the frozen five
// appends at field 8+ in vocabulary order as `<key>=<value>`, so adding a column never re-keys the rows
// written before it.
//
// --- 9. Ordinal on collision
//
// Two rows on one day can be identical — two 30m entries, same project, same label, no note. (PLAN-009's
// Family D golden contains exactly that pair, and asserts nothing collapses them.) The key is:
//
// ```
// <digest>      first occurrence
// <digest>#2    second
// <digest>#3    third …
// ```
//
// counting top to bottom in row order. Only duplicates are order-dependent: reordering distinct rows
// changes nothing, and swapping two identical rows is a no-op by construction.
//
// --- 10. The hash function is phase 3's
//
// This spec pins the string. Which hash and how far it is truncated is phase 3's to choose — and to
// record in exactly one place when it does.
//
// --- 11. The date comes from the note, not the block
//
// SB-045's format has no date column; the filename carries it, and `TT.parseVaultBlock`'s `opts.date`
// supplies it. A key is therefore day-scoped by construction, which is also what makes rule 9's ordinal
// well defined.
//
// --- 12. Known re-key hazards — recorded, not decided
//
// Each of these would change the digest of rows already on disk, so each is a migration if it lands after
// notes exist:
//
// - SB-059's `Project` wikilink↔code mapping — LANDED, and still a live hazard, because it is
//   OPT-IN. Field 4 holds the resolved CODE when a caller passes `projects` and some project claims
//   the note, and the verbatim `[[Planning]]` otherwise. So the day SB-056/SB-057 starts passing the
//   catalog, every row whose project has a `vaultNote` re-keys. Turning the option on is the
//   migration, not merging this ticket.
// - SB-076, if ruled "normalise `<br>` lookalikes", changes note values.
// - Rule 4's consequence — editing a row changes its key, so a committed entry that is later edited
//   loses its `commitSnapshot` link. Filed as SB-079 rather than decided here, because whether
//   phase 3 needs identity to survive an edit is SB-057's arbitration question, not this spec's.

// ---- id preservation across an import (SB-117, DD-019 ruling 3) ----
//
// WHAT THIS IS FOR. `TimeGrid` keys every grid row `key={entry.id}` and DD-008 makes the runtime id
// EPHEMERAL — re-minted by every parse. So an import of day D used to change every id on day D, and
// the refresh that followed remounted every row on that day. `NoteCell` holds the sentence you are
// typing in local component state until blur, so a remount destroyed it and ejected the caret. With
// ids preserved, a 409 reload is very nearly invisible: unchanged rows do not remount, and only
// genuinely-changed rows flicker.
//
// THIS IS NOT DD-008's PERSISTENCE KEY, and must not be mistaken for it. Nothing is hashed and
// nothing is stored — rule 10 stays phase 3's to choose. This is field equality between an incoming
// parsed row and a row already in the index, computed in memory and thrown away in the same tick.
//
// THE FIELD SET IS DD-008 rule 2's ORDER WITH TWO SLOTS DELIBERATELY EMPTY — `mode` (field 3) and
// the passthrough columns (field 8+). Not an oversight, and not a disagreement with the spec: the
// SQLite index has no `tags` column and no `vaultCells` column (see `getEntries` in server/src/db.js,
// where the `Omit` says so out loud), so the stored side of this comparison can never carry either.
// Including them would make every Mode-bearing row fail to match its own unchanged self and mint a
// fresh id — turning this off for exactly the rows Terje puts tags on.
//
// The cost of leaving them out, stated rather than discovered: a row whose ONLY change is its Mode
// cell reads as unchanged and keeps its id. That is the benign direction. Keeping the id means React
// updates the row in place with the new tags instead of remounting it, which is the outcome this
// ticket wants anyway; the harm the ticket is about is the remount, not the id.
//
// TRIM ON BOTH SIDES. `putEntries` trims `label` and `note` on the way in, so an untrimmed parsed
// row would otherwise never match the trimmed copy of itself that the previous import stored.
/**
 * The field-equality key two rows must share to count as the same row. In-memory only.
 * @param {Entry} entry @returns {string}
 */
TT.entryMatchKey = function (entry) {
  // DD-008 rule 4's three legal shapes plus the empty cell. Minutes since midnight; the emitted
  // separator is not part of it, so flipping `vaultTimeSeparator` (SB-063) re-keys nothing.
  const time =
    entry.start != null && entry.end != null
      ? 'range:' + entry.start + '-' + entry.end
      : entry.start != null
        ? 'running:' + entry.start
        : entry.durMin != null
          ? 'duration:' + entry.durMin
          : 'none';
  // Rule 3's join: U+001F, which no markdown table cell can carry through TT's parser, so empty
  // fields stay unambiguous without rule 5 needing a placeholder.
  return [
    entry.date || '',
    time,
    entry.project == null ? '' : String(entry.project),
    String(entry.label ?? '').trim(),
    String(entry.note ?? '').trim(),
    entry.billable ? '1' : '0', // rule 7: no Bill column at all parses to billable, so it keys as `1`
  ].join('\u001F');
};

/**
 * Give each incoming row the id its unchanged counterpart already holds in the index.
 *
 * DUPLICATES ARE MATCHED IN ROW ORDER — DD-008 rule 9's answer to the same problem. Two identical
 * rows on one day share a key, so their ids form a pool that is drawn from top to bottom. Which of
 * the two gets which id is unobservable by construction: the rows are identical.
 *
 * `existing` arrives in `getEntries` order (`ORDER BY date, id`), which is NOT the note's row order.
 * That only matters for duplicates, where by the paragraph above it does not matter at all.
 *
 * Pure: returns new objects and mutates neither argument.
 * @param {Entry[]} incoming rows just parsed out of the note, in the note's row order
 * @param {Entry[]} existing rows the index already holds for that day
 * @returns {Entry[]} `incoming`, with ids reused wherever the content is unchanged
 */
TT.preserveEntryIds = function (incoming, existing) {
  /** @type {Map<string, string[]>} */
  const pool = new Map();
  for (const entry of existing || []) {
    const key = TT.entryMatchKey(entry);
    const ids = pool.get(key);
    if (ids) ids.push(entry.id);
    else pool.set(key, [entry.id]);
  }
  return (incoming || []).map((entry) => {
    const ids = pool.get(TT.entryMatchKey(entry));
    const id = ids && ids.length ? ids.shift() : null;
    // A genuinely-changed row keeps the id its parse just minted — the remount is correct there.
    return id == null ? entry : { ...entry, id };
  });
};

TT.serializeMd = function (state) {
  const lines = [
    '# timesheet',
    '',
    'currency: ' + (state.settings.currency || 'kr'),
    'language: ' + (state.settings.language || 'en'),
    'format: 2',
    '',
    '## clients',
  ];
  // ` | archived` (ruling 7) rides along only when the client is archived, so every
  // active client — the whole migrated-from-v1 mirror — stays byte-identical.
  state.clients.forEach((client) =>
    lines.push(
      '- ' +
        TT.encodeCell(client.id) +
        ' | ' +
        TT.encodeCell(client.name) +
        ' | round ' +
        (client.rounding || 'exact') +
        (client.rate != null ? ' | rate ' + client.rate : '') +
        (client.archived ? ' | archived' : ''),
    ),
  );
  lines.push('', '## projects');
  // ` | nb` rides along only when the project's billable default is off, so every
  // billable-by-default project — the whole migrated-from-v1 mirror — stays byte-identical.
  state.projects.forEach((project) =>
    lines.push(
      '- ' +
        TT.encodeCell(project.code) +
        ' | ' +
        TT.encodeCell(project.name) +
        ' | ' +
        (project.clientId ? TT.encodeCell(project.clientId) : '—') +
        (project.rate != null ? ' | rate ' + project.rate : '') +
        (project.billable === false ? ' | nb' : '') +
        (project.archived ? ' | archived' : ''),
    ),
  );
  lines.push('', '## tasks');
  // Per-user templates: id | label | project. No billable (SDD-002 moved it to the project).
  state.tasks.forEach((task) =>
    lines.push(
      '- ' +
        TT.encodeCell(task.id) +
        ' | ' +
        TT.encodeCell(task.label) +
        ' | ' +
        (task.project ? TT.encodeCell(task.project) : '—'),
    ),
  );
  const dates = [...new Set(state.entries.map((entry) => entry.date))].sort();
  dates.forEach((date) => {
    lines.push('', '## ' + date);
    state.entries
      .filter((entry) => entry.date === date)
      .forEach((entry) => {
        // v2 entry: <time> | <project> | <label> | <note>[ [nb]][ [ea]]. label + project
        // are copied at birth; [nb] rides the note field as in v1 (frozen per-entry
        // billable). [ea] (edited-by-admin, SB-025) rides the same way, emit-when-true and
        // after [nb], so a not-edited entry stays byte-identical to the existing golden.
        // SB-041: escape FIRST, then append the flag markers UNESCAPED — they are
        // structure, not content, and parseMd peels them before it decodes.
        lines.push(
          '- ' +
            (TT.fmtTimeCell(entry) || '?') +
            ' | ' +
            (entry.project ? TT.encodeCell(entry.project) : '—') +
            ' | ' +
            TT.encodeCell(entry.label || '') +
            ' | ' +
            TT.encodeNoteCell(entry.note || '') +
            (entry.billable ? '' : ' [nb]') +
            (entry.editedByAdmin ? ' [ea]' : ''),
        );
      });
  });
  // SDD-002 ruling 4: an ADDITIVE `## commits` section (no version bump — pre-authorized
  // by PLAN-003). Emitted ONLY when there is at least one committed segment, so v1 and
  // no-commit v2 mirrors stay byte-identical. Each segment is a `- <key> | <committedAt>`
  // header followed by one indented `  - <entryId> | <rate> | <billMin> | <amount>` row
  // per frozen entry (the snapshot); an absent section parses back to `commits: []`.
  //
  // ESCAPING EXEMPTION — READ THIS BEFORE ADDING A SECTION (SB-041, ruled again in SB-070).
  // This section is deliberately NOT routed through encodeCell/decodeCell. Every field in it
  // is machine-generated (segment keys from TT.segmentKey, ISO timestamps, entry ids,
  // numbers), so no user content reaches it and emit-when-needed would be a no-op. Both
  // sides agree: nothing is escaped here and nothing is unescaped.
  //
  // THE ESCAPING IS THEREFORE NOT UNIVERSAL ACROSS SECTIONS. `## clients` / `## projects` /
  // `## tasks` / the date sections escape; `## commits` does not. SB-055 (and anything else
  // adding a section or a field here) must not assume otherwise: put a `|` in a field this
  // section emits raw and it splits its own row. An entry id `a|b` emits
  // `  - a|b | 1250 | 60 | 100`, which parses back to snapshot key `a` with rate NaN —
  // committed money silently rewritten on a mirror restore.
  //
  // SB-070 ruling (Terje, option 1): the hole is closed at the SOURCE, not here. The server
  // charset-validates entry ids at the API boundary (`entryIdError` in server/src/index.js,
  // `[A-Za-z0-9._-]`), so no `|` can reach this serializer through a PUT. Routing the section
  // through encodeCell was considered and REJECTED — it escapes fields that never need it and
  // leaves the hostile-input path itself open. Do not "fix" this by adding escaping here
  // without re-opening that ruling; the golden mirrors depend on these bytes.
  //
  // SB-074 closed the other half the same way. The SEGMENT KEY is worse than an entry id — an id
  // is machine-minted by nid(), but the key comes verbatim from the request body, and a `|` in it
  // splits the segment HEADER (`- <key> | <committedAt>`), manufacturing two segments with one key
  // so commitSnapshot's first-match-wins returns the wrong (empty) one. `commitLedgerError` in
  // server/src/index.js now rejects it, plus a non-ISO `committedAt` and a repeated key. The key
  // check is DERIVED from TT.segmentKey (a key is valid iff some real date produces it), so the
  // grammar above stays its one home — do not copy it into a regex somewhere else.
  const commits = state.commits;
  if (commits && commits.length) {
    lines.push('', '## commits');
    commits.forEach((seg) => {
      // SDD-002 ruling 5 (SB-025): approved:/released: ride the segment header as LABELED
      // optional tokens, emitted only when present so a plain committed segment stays
      // byte-identical. Labeled (not positional) so a released-but-unapproved segment is
      // unambiguous. approvedAt and releasedBy are mutually exclusive by construction.
      lines.push(
        '- ' +
          seg.key +
          ' | ' +
          seg.committedAt +
          (seg.approvedAt ? ' | approved:' + seg.approvedAt : '') +
          (seg.releasedBy != null ? ' | released:' + seg.releasedBy : ''),
      );
      for (const [entryId, snap] of Object.entries(seg.snapshot)) {
        lines.push('  - ' + entryId + ' | ' + snap.rate + ' | ' + snap.billMin + ' | ' + snap.amount);
      }
    });
  }
  return lines.join('\n') + '\n';
};
// v1 → v2 migration (in place, on the intermediate parse). Reads the pre-v2 shape —
// entries with a `._task` id and tasks with `._name` — and resolves each entry's task
// id into its own copied label + project. A dangling id becomes label = the raw id,
// project = null: today's silent loss made VISIBLE, not permanent.
//
// NOTE: the ENTRY copy here (incl. dangling → raw-id label) matches the server's
// one-shot DB migration (server/src/db.js migrateToSdd002). TEMPLATE reconstruction
// deliberately differs: this markdown path is already per-user, so it keeps every
// `## tasks` row as a template; the DB path seeds each user's templates from the tasks
// THEIR entries reference (SDD-002's rule for fanning a shared table out per user).
// `state` here is the loose INTERMEDIATE parse (entries carry `_task`, tasks `_name`),
// so its collections are typed `any[]` — normalized into a proper Catalog by the end.
/** @param {{ entries: any[], tasks: any[], projects: any[] }} state */
function migrateV1(state) {
  // legacy fixup: an entry ref that is a project code (not a task id) becomes a
  // "general" template on that project (preserves the pre-v2 behaviour).
  //
  // SB-088: this slugs a value that already exists (a v1 project code), but it MINTS a
  // template id inside this one parse and points the entry at it in the same breath, so
  // the new rule cannot orphan a reference — both sides of the join move together. A v1
  // file could only hold a non-ASCII code if it was hand-written; the old makeCode
  // deleted those letters before they ever reached a file.
  state.entries.forEach((entry) => {
    if (
      entry._task &&
      !state.tasks.some((task) => task.id === entry._task) &&
      state.projects.some((project) => project.code === entry._task)
    ) {
      const id = TT.slug(entry._task) + '-general';
      if (!state.tasks.some((task) => task.id === id)) state.tasks.push({ id, _name: 'General', project: entry._task });
      entry._task = id;
    }
  });
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  state.entries.forEach((entry) => {
    const task = entry._task != null ? byId.get(entry._task) : null;
    if (task) {
      entry.label = task._name;
      entry.project = task.project;
    } else if (entry._task != null) {
      entry.label = entry._task; // dangling id — surfaced as the label, never dropped
      entry.project = null;
    }
    delete entry._task;
  });
  // templates: {id, _name, project} → {id, label, project} (task-level billable is
  // intentionally NOT mapped; the project owns billable now — admin re-marks nb projects).
  state.tasks = state.tasks.map((task) => ({ id: task.id, label: task._name, project: task.project }));
}
// The NAME cell of a catalog row — the client/project/task display name that sits in cell 1,
// next to the id in cell 0. One reader for all three sections, because `parts[1] || parts[0]`
// was written out three times and they must agree.
//
// PRESENT-BUT-EMPTY vs ABSENT (SB-107, ruled 2026-07-26). `||` conflated them, so an empty name
// came back as its own id: `- fjellheim |  | round exact` parsed to `name: 'fjellheim'`, and
// serialize→parse was not idempotent for a value the write edge accepts. An empty name is a LEGAL
// STORED VALUE — SB-075 trims `'   '` to `''` at the write edge, which is exactly what made this
// reachable — so an empty cell reads back as `''`. The id fallback survives for the case it was
// actually for: a row with NO name cell at all (`- fjellheim`), which a hand-edited or pre-v2
// mirror can carry and where there is no stored value to preserve.
/** @param {string[]} parts trimmed, still-escaped cells @returns {string} */
const nameCell = (parts) => TT.decodeCell(parts[1] === undefined ? parts[0] : parts[1]);
TT.parseMd = function (md) {
  /** @type {import('./types.ts').CommitSegment[]} */
  const commits = [];
  /** @type {Catalog} */
  const state = {
    settings: { currency: 'kr', language: 'en' },
    clients: [],
    projects: [],
    tasks: [],
    entries: [],
    commits, // always present after parse; empty for v1 / no-commit v2 (ruling 4)
  };
  /** @type {string | { date: string } | null} */
  let section = null;
  /** @type {import('./types.ts').CommitSegment | null} */
  let currentCommit = null; // the `## commits` segment whose indented snapshot rows follow
  let version = 1; // v1 has no marker; `format: 2` (in the header) upgrades the parse path
  for (const line of md.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let match = /^currency:\s*(.+)$/.exec(trimmed);
    if (match && !section) {
      state.settings.currency = match[1].trim();
      continue;
    }
    match = /^language:\s*(.+)$/.exec(trimmed);
    if (match && !section) {
      state.settings.language = match[1].trim();
      continue;
    }
    match = /^format:\s*(\d+)$/.exec(trimmed);
    if (match && !section) {
      version = +match[1];
      continue;
    }
    match = /^##\s+(.+)$/.exec(trimmed);
    if (match) {
      const heading = match[1].trim().toLowerCase();
      section = /^\d{4}-\d{2}-\d{2}$/.test(heading) ? { date: heading } : heading;
      currentCommit = null; // a new section ends any in-progress commit segment
      continue;
    }
    if (!trimmed.startsWith('- ')) continue;
    // SB-041: split on UNESCAPED `|` only; cells stay escaped until each branch has
    // read the structure out of them (rule tokens, flag markers), then decode.
    const parts = TT.splitCells(trimmed.slice(2));
    if (section === 'clients') {
      /** @type {Client} */
      const client = {
        id: TT.decodeCell(parts[0]),
        name: nameCell(parts),
        rounding: 'exact',
        rate: null,
        archived: false,
      };
      for (const part of parts.slice(2)) {
        let ruleMatch = /^round\s+(\S+)/.exec(part);
        if (ruleMatch) client.rounding = ruleMatch[1] === 'exact' ? 'exact' : +ruleMatch[1];
        ruleMatch = /^rate\s+([\d.]+)/.exec(part);
        if (ruleMatch) client.rate = +ruleMatch[1];
        if (part === 'archived') client.archived = true;
      }
      state.clients.push(client);
    } else if (section === 'projects') {
      /** @type {Project} */
      const project = {
        code: TT.decodeCell(parts[0]),
        name: nameCell(parts),
        clientId: null,
        rate: null,
        billable: true,
        archived: false,
      };
      if (parts[2] && parts[2] !== '—') project.clientId = TT.decodeCell(parts[2]);
      // SB-041 (failure 3): the rule scan starts at 3, NOT 2 — parts[2] is the positional
      // clientId and a client whose id is `nb`/`archived` was being read as a flag (and
      // then re-emitted as one, so the corruption was not even idempotent).
      for (const part of parts.slice(3)) {
        const ruleMatch = /^rate\s+([\d.]+)/.exec(part);
        if (ruleMatch) project.rate = +ruleMatch[1];
        if (part === 'nb') project.billable = false;
        if (part === 'archived') project.archived = true;
      }
      state.projects.push(project);
    } else if (section === 'tasks') {
      const project = parts[2] && parts[2] !== '—' ? TT.decodeCell(parts[2]) : null;
      const id = TT.decodeCell(parts[0]),
        label = nameCell(parts);
      if (version >= 2) {
        state.tasks.push({ id, label, project });
      } else {
        // v1 intermediate — keep _name so migrateV1 can copy it onto entries
        state.tasks.push(/** @type {any} */ ({ id, _name: label, project }));
      }
    } else if (section === 'commits') {
      // SDD-002 ruling 4: a top-level `- key | committedAt` row opens a segment; the
      // indented `  - entryId | rate | billMin | amount` rows below it are its frozen
      // snapshot. Indentation on the RAW line is what distinguishes the two.
      if (/^\s/.test(line)) {
        if (currentCommit) {
          currentCommit.snapshot[parts[0]] = { rate: +parts[1], billMin: +parts[2], amount: +parts[3] };
        }
      } else {
        currentCommit = { key: parts[0], committedAt: parts[1] || '', snapshot: {} };
        // SDD-002 ruling 5 (SB-025): labeled optional approved:/released: tokens; absent
        // by default, so a plain committed segment parses back with neither field.
        for (const token of parts.slice(2)) {
          let tokenMatch = /^approved:(.+)$/.exec(token);
          if (tokenMatch) currentCommit.approvedAt = tokenMatch[1];
          tokenMatch = /^released:(.+)$/.exec(token);
          if (tokenMatch) currentCommit.releasedBy = +tokenMatch[1];
        }
        commits.push(currentCommit);
      }
    } else if (section && typeof section === 'object' && section.date) {
      const parsed = TT.parseTimeCell(parts[0] || '');
      if (version >= 2) {
        // v2 entry: <time> | <project> | <label> | <note>[ [nb]][ [ea]]. Strip the
        // trailing [nb]/[ea] markers in any order (order-independent so a future emit
        // order never breaks the round-trip). SB-041: the peel runs on the STILL-ESCAPED
        // note and stops at a `\[nb]`, so a note whose text ends in a marker keeps it.
        const { note, billable, editedByAdmin } = decodeNoteCell(parts[3] || '');
        const project = parts[1] && parts[1] !== '—' ? TT.decodeCell(parts[1]) : null;
        /** @type {Entry} */
        const entry = {
          id: nid(),
          date: section.date,
          start: null,
          end: null,
          durMin: null,
          project,
          label: TT.decodeCell(parts[2] || ''),
          note,
          billable,
        };
        if (editedByAdmin) entry.editedByAdmin = true;
        applyParsed(entry, parsed);
        state.entries.push(entry);
      } else {
        // v1 entry: <time> | <task> | <note>[ [nb]] — parsed into an intermediate carrying ._task.
        // v1 knows only [nb] (no [ea]); that stays true, it just became escape-aware.
        let note = parts[2] || '',
          billable = true;
        const nbAt = /\[nb\]\s*$/.exec(note);
        if (nbAt && !isEscapedAt(note, nbAt.index)) {
          billable = false;
          note = note.slice(0, nbAt.index).replace(/\s+$/, '');
        }
        note = TT.decodeCell(note);
        const ref = parts[1] && parts[1] !== '—' ? TT.decodeCell(parts[1]) : null;
        const entry = /** @type {any} */ ({
          id: nid(),
          date: section.date,
          start: null,
          end: null,
          durMin: null,
          _task: ref,
          project: null,
          label: '',
          note,
          billable,
        });
        applyParsed(entry, parsed);
        state.entries.push(entry);
      }
    }
  }
  if (version < 2) migrateV1(state);
  return state;
};
TT.newEntry = function (date, parsed) {
  /** @type {Entry} */
  const entry = {
    id: nid(),
    date,
    start: null,
    end: null,
    durMin: null,
    project: null,
    label: '',
    note: '',
    billable: true,
  };
  applyParsed(entry, parsed);
  return entry;
};

TT.seedMd = function () {
  const T = TT.todayStr(),
    D = (/** @type {number} */ n) => TT.addDays(T, -n);
  return [
    '# timesheet',
    '',
    'currency: kr',
    'format: 2',
    '',
    '## clients',
    '- fjellheim | Fjellheim AS | round 15 | rate 1250',
    '- brygga | Brygga Digital | round exact | rate 990',
    '',
    '## projects',
    '- FJH-NETT | Nettbutikk rebuild | fjellheim',
    '- FJH-DRIFT | Drift & support | fjellheim | rate 1400',
    '- BRY-APP | Booking-app MVP | brygga',
    '- INT-ADM | Internal admin | —',
    '',
    '## tasks',
    '- checkout | Checkout flow | FJH-NETT',
    '- product-pages | Product page templates | FJH-NETT',
    '- search | Search & facets | FJH-NETT',
    '- ops | Ops & maintenance | FJH-DRIFT',
    '- booking-flow | Booking flow | BRY-APP',
    '- calendar | Calendar component | BRY-APP',
    '- payments | Payment integration | BRY-APP',
    '- admin | Admin & invoicing | INT-ADM',
    '',
    '## ' + D(9),
    '- 09:00→15:30 | FJH-NETT | Checkout flow | information architecture',
    '- 5h | BRY-APP | Booking flow | first spike',
    '## ' + D(8),
    '- 08:30→12:00 | FJH-NETT | Checkout flow | wireframes',
    '- 12:30→16:45 | FJH-DRIFT | Ops & maintenance | cert renewal + patching',
    '## ' + D(7),
    '- 6h | BRY-APP | Calendar component | drag to select range',
    '- 45m | INT-ADM | Admin & invoicing | invoicing [nb]',
    '## ' + D(2),
    '- 08:30→12:00 | FJH-NETT | Product page templates | ',
    '- 13:00→17:00 | BRY-APP | Payment integration | vipps + stripe',
    '## ' + D(1),
    '- 09:00→11:00 | FJH-DRIFT | Ops & maintenance | migrate staging server',
    '- 11:15→15:30 | FJH-NETT | Search & facets | facet filters',
    '- 30m | INT-ADM | Admin & invoicing | weekly review [nb]',
    '## ' + T,
    '- 09:00→11:30 | FJH-NETT | Checkout flow | design review',
  ].join('\n');
};
TT.seed = () => TT.parseMd(TT.seedMd());

export default TT;
export { TT };
