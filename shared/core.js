// @ts-check
// Time Turtle core: parsing, model, markdown serialization.
// Shared between client (UI + i18n overrides) and server (markdown mirror).
/** @typedef {import('./types.ts').Entry} Entry */
/** @typedef {import('./types.ts').VaultEntry} VaultEntry */
/** @typedef {import('./types.ts').Task} Task */
/** @typedef {import('./types.ts').Project} Project */
/** @typedef {import('./types.ts').Client} Client */
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
/**
 * @param {Entry} entry
 * @param {VaultTimeSeparator} [separator] a `Settings.vaultTimeSeparator` value name. Defaults to
 *   `unicode`, which is what every NON-vault caller wants and must keep getting: this
 *   formatter also serves the v2 mirror's entry lines, whose bytes SB-069 froze
 *   (`backend=sqlite` comes out of the vault effort byte-for-byte identical), and the app's
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
TT.slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'task';
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
// The v2 `|`-mirror below is not that file — it is written by the `backend=sqlite` path
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
// NAME. Escaping composes on top: the cell is `[[` + note + `]]` and THEN TT.encodeCell'd, so
// a `|` in a note name escapes like any other content and cannot split the row.
const WIKILINK_RE = /^\[\[(.+)\]\]$/;
/**
 * How a project code is written in a `Project` cell (still UNescaped).
 * @param {string} code @param {Project[]} [projects] @returns {string}
 */
function vaultProjectCell(code, projects) {
  if (!projects) return code;
  const project = projects.find((candidate) => candidate.code === code);
  return project && project.vaultNote ? '[[' + project.vaultNote + ']]' : code;
}
/**
 * The inverse: a decoded `Project` cell back to a project code. First match wins — two
 * projects claiming one note is a catalog the UI has to prevent, not something the parser
 * can arbitrate.
 * @param {string} value decoded cell @param {Project[]} [projects] @returns {string}
 */
function vaultProjectCode(value, projects) {
  if (!projects) return value;
  const m = WIKILINK_RE.exec(value);
  if (!m) return value;
  const project = projects.find((candidate) => candidate.vaultNote === m[1]);
  return project ? project.code : value;
}

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
 * DO NOT REUSE THIS FOR DD-008's ENTRY KEY. That digest is over PARSED VALUES of one row, so
 * escaping and the `→`/`->` separator setting drop out of it (DD-008 rule 1); this one is over
 * the RAW LINE BYTES of the whole block, precisely so that any byte-level change — including
 * one that parses back to the same values — is caught. Different question, different input.
 * DD-008 rule 10 leaves the entry-key hash to phase 3 to choose; this is not it.
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
/** @param {string[]} payloadLines @returns {string} */
const vaultPayloadDigest = (payloadLines) => vaultDigest(payloadLines.join('\n'));
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

  // 1. the top anchor — the heading TEXT compared exactly, never interpolated into a regex
  /** @type {number[]} */
  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    if (!fenced[i] && isHeadingAnchor(lines[i], heading)) anchors.push(i);
  }
  // diagnose CRLF rather than blaming the heading — 'no-heading' would send a human looking in
  // the wrong place forever
  if (!anchors.length) return vaultQuarantine(crlf ? 'crlf-line-endings' : 'no-heading');
  // two blocks with one name: nothing can say which is the day's, so neither is writable. This
  // one does NOT defer to `crlf` — it found MORE than it expected, which a `\r` cannot explain,
  // so the specific reason is the useful one (same for 'multiple-revisions' below).
  if (anchors.length > 1) return vaultQuarantine('multiple-headings');
  const start = anchors[0];

  // 2. the hard stop — the next heading of any level ends the region, full stop
  let stop = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (fenced[i]) continue;
    if (/^#{1,6}[ \t]/.test(lines[i])) {
      stop = i;
      break;
    }
  }

  // 3. the bottom anchor, which must sit BEFORE the hard stop
  /** @type {{ line: number, revision: number, digest: string | null }[]} */
  const revLines = [];
  for (let i = start + 1; i < stop; i++) {
    const m = fenced[i] ? null : REVISION_RE.exec(lines[i]);
    if (m) revLines.push({ line: i, revision: +m[1], digest: m[2] || null });
  }
  if (!revLines.length) {
    // name the dangerous case precisely: the anchor exists, but only in someone else's section
    for (let i = stop; i < lines.length; i++) {
      if (!fenced[i] && REVISION_RE.test(lines[i]))
        return vaultQuarantine(crlf ? 'crlf-line-endings' : 'revision-past-next-heading');
    }
    return vaultQuarantine(crlf ? 'crlf-line-endings' : 'no-revision');
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
const VAULT_COLUMNS = ['Time', 'Mode', 'Project', 'Task', 'Bill'];
const VAULT_KEYS = VAULT_COLUMNS.map((label) => label.toLowerCase());
const BILL_YES = '✓'; // U+2713. SB-045: `✓` or blank — never `—`, and nothing else parses.
/**
 * Parse the vault block into entries, or propagate the locator's quarantine verdict.
 * `opts.date` is the note's date: SB-045's format has NO date column (the filename
 * carries it), so SB-056/SB-057 supply it here. It defaults to '' rather than today, so
 * a caller that forgets it produces a visibly dateless entry instead of a silently
 * misdated one.
 * @param {string} md @param {{ heading?: string, date?: string, projects?: Project[] }} [opts]
 * @returns {import('./types.ts').VaultBlockParseResult}
 */
TT.parseVaultBlock = function (md, opts) {
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
    if (!VAULT_KEYS.includes(key)) return vaultQuarantine('unknown-header');
    if (keys.includes(key)) return vaultQuarantine('duplicate-header');
    keys.push(key);
  }

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
        entry.project = raw === '' ? null : vaultProjectCode(TT.decodeCell(raw), projects);
      } else if (keys[c] === 'task') {
        const { label, note } = TT.decodeTaskCell(raw);
        entry.label = label;
        entry.note = note;
      } else if (keys[c] === 'bill') {
        // exactly `✓` or exactly blank. Anything else is a hand edit whose intent TT
        // cannot know, and this cell decides money — so it refuses instead of guessing.
        if (raw === BILL_YES) entry.billable = true;
        else if (raw === '') entry.billable = false;
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
  return { quarantine: false, heading: loc.heading, revision: loc.revision, headers, entries, verified: loc.verified };
};

// ---- vault block serialize + splice (SB-055) ----
// Emits exactly SB-045's frozen shape:
//
//   ## Time Log
//
//   | Time | Mode | Project | Task | Bill |
//   |---|---|---|---|---|
//   | 09:00→09:15 | #admin | [[Planning]] | Daily planning ritual | |
//   | **8.7h** | | | | **5.1h billable** |
//
//   `revision: 8`
//
// The header row is written ALWAYS, including on a zero-entry day — no header means no
// schema. An empty cell is one space between pipes (`| |`), never two, which is what makes
// the emitted bytes and SB-045's own example the same string.
//
// THE TASK CELL USES TT.encodeTaskCell, NEVER TT.encodeNoteCell. encodeNoteCell escapes a
// trailing `[nb]`/`[ea]` run, which is the v2 MIRROR's flag convention; the vault carries
// billability in a dedicated `Bill` column, so routing through it would put a spurious
// backslash on a note that happens to end in `[nb]`.
/**
 * One table line. An empty cell is a single space, matching SB-045's example bytes.
 * @param {string[]} cells @returns {string}
 */
const vaultRow = (cells) => '|' + cells.map((c) => (c === '' ? ' ' : ' ' + c + ' ')).join('|') + '|';
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

  const lines = ['## ' + heading, '', vaultRow(headers), '|' + headers.map(() => '---').join('|') + '|'];
  for (const entry of rows) {
    lines.push(
      vaultRow(
        keys.map((key) => {
          if (key === 'time') return TT.fmtTimeCell(entry, timeSeparator);
          if (key === 'mode') return TT.encodeTagsCell(entry.tags);
          if (key === 'project') return entry.project ? TT.encodeCell(vaultProjectCell(entry.project, projects)) : '';
          if (key === 'task') return TT.encodeTaskCell({ label: entry.label, note: entry.note });
          if (key === 'bill') return entry.billable ? BILL_YES : '';
          // a vocabulary column TT has no model field for — re-emitted verbatim from the raw
          // cell the parser carried. Empty today (SB-059 gave `Mode` a home); SB-044's
          // settings-extended vocabulary is what refills it
          return (entry.vaultCells && entry.vaultCells[key]) || '';
        }),
      ),
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
  // them one decision. Fallbacks keep a degenerate header set writable: no `Time` column puts
  // the hours in column 0, no `Bill` column puts the billable total in the last one, and if
  // those collide the hours win (a one-column block has nowhere else to put them).
  const { min, bill } = vaultTotals(rows);
  const totals = headers.map(() => '');
  const timeAt = keys.indexOf('time') >= 0 ? keys.indexOf('time') : 0;
  const billAt = keys.indexOf('bill') >= 0 ? keys.indexOf('bill') : headers.length - 1;
  totals[timeAt] = '**' + TT.fmtHours(min) + 'h**';
  if (billAt !== timeAt) totals[billAt] = '**' + TT.fmtHours(bill) + 'h billable**';
  lines.push(vaultRow(totals));
  // `lines` is `['## heading', '', header, delimiter, ...rows]` at this point, so everything from
  // index 2 to the end IS the payload — taken before the blank line and the revision line are
  // appended, which is what keeps them out of it without any filtering.
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
 * @param {string} md @param {VaultEntry[]} entries
 * @param {{ heading?: string, date?: string, headers?: string[], revision?: number, timeSeparator?: VaultTimeSeparator, projects?: Project[] }} [opts]
 * @returns {{ md: string, quarantine: boolean, reason: import('./types.ts').VaultQuarantineReason | null }}
 */
TT.writeVaultBlock = function (md, entries, opts) {
  const input = String(md == null ? '' : md);
  const parsed = TT.parseVaultBlock(input, opts);
  if (parsed.quarantine) return { md: input, quarantine: true, reason: parsed.reason };
  // Re-locating is not redundant: parseVaultBlock returns values, not line offsets, and this
  // also narrows the union for @ts-check so `loc.heading` below is legal. Do not delete it.
  const loc = TT.locateVaultBlock(input, opts);
  if (loc.quarantine) return { md: input, quarantine: true, reason: loc.reason };
  const lines = input.split('\n');
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
  if (TT.parseVaultBlock(out, opts).quarantine) return { md: input, quarantine: true, reason: 'write-would-corrupt' };
  return { md: out, quarantine: false, reason: null };
};

// ---- canonical row string (DD-008 spec obligation — nothing computes this in phase 1) ----
// Phase 1 computes and stores nothing. Committing is off for `backend=vault` under phase 1+2, so the
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
        name: TT.decodeCell(parts[1] || parts[0]),
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
        name: TT.decodeCell(parts[1] || parts[0]),
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
        label = TT.decodeCell(parts[1] || parts[0]);
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
