// @ts-check
// Time Turtle core: parsing, model, markdown serialization.
// Shared between client (UI + i18n overrides) and server (demo seed, commit rules).
/** @typedef {import('./types.ts').Entry} Entry */
/** @typedef {import('./types.ts').Task} Task */
/** @typedef {import('./types.ts').Project} Project */
/** @typedef {import('./types.ts').Client} Client */
/** @typedef {import('./types.ts').Rounding} Rounding */
/** @typedef {import('./types.ts').Settings} Settings */
/** @typedef {import('./types.ts').Catalog} Catalog */
/** @typedef {import('./types.ts').ParsedTime} ParsedTime */
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
/**
 * DOES THE LEDGER HOLD THIS DAY'S SEGMENT? — the one MEMBERSHIP scan the read-only rule shares.
 *
 * Role-blind: it answers a question about the ledger and nothing else. `readOnlyDay` gates THIS
 * rather than writing the walk again, and through `readOnlyDay` so does the client's lock
 * expression (`TimeGrid.tsx`).
 *
 * NOT the only code in the repo that walks the ledger: `viewUtils.isApproved`, `TT.commitSnapshot`
 * and `TT.monthSegments` walk it too. They ask different questions — is it approved, what money was
 * frozen, what does the month roll up to. What must not exist twice is *this* question, because two
 * answers to "is this day committed" is a rule that agrees today and diverges on the first ruling.
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
 * CAN THIS DAY BE TYPED INTO? — SDD-002 ruling 5/6, the rule the grid and the server both read.
 *
 * A day inside a committed segment is read-only for a non-admin. An admin edits it anyway
 * (ruling 6, the committed-segment admin exemption).
 * @param {string} date @param {import('./types.ts').ReadOnlyDayContext} context @returns {boolean}
 */
TT.readOnlyDay = function (date, context) {
  const ctx = context || {};
  if (typeof date !== 'string') return false;
  return !ctx.admin && TT.committedOn(date, ctx.commits);
};

/** @param {Entry} entry @returns {string} */
TT.fmtTimeCell = function (entry) {
  if (entry.durMin != null) return TT.fmtDur(entry.durMin); // a duration has no separator
  if (entry.start != null) return TT.fmtT(entry.start) + '→' + (entry.end != null ? TT.fmtT(entry.end) : '');
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
// cap; the id is a visible join key in the markdown codec, so its width is a promise to the
// reader.
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
// as `refactored the` with billable falsely flipped off.
//
// Scheme: backslash escapes the following character. Only three characters are ever
// emitted escaped:
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
// does not distinguish a file written before this change from one written after, and the
// marker is the only thing that could. In a PRE-change file a backslash is a literal, so
// `see C:\work` now reads back as `see C:work`. Ruled ACCEPT AS IS — an accepted one-way
// migration, and `decodeCell` stays UNCONDITIONAL.
//
// `TT.splitUnescaped` / `TT.splitCells` are public; `decodeNoteCell` is not — it has one caller,
// parseMd.
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
