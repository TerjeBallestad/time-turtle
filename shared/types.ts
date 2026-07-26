// Time Turtle — shared type source of truth.
// Imported by the client (full TS) and referenced from server/shared JS via
// JSDoc `@typedef {import('../../shared/types.ts').Entry} Entry`.
// FROZEN (SB-003): field names, JSON shapes and method names below are the data
// model contract — the golden round-trip test pins the markdown serialization.

// ---- roles / users ----
export type Role = 'admin' | 'employee';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  /** present on listUsers() rows; absent on the session `user` */
  createdAt?: string;
}

// ---- data model ----
/** A client's per-entry billing rounding: 'exact' or a minute increment. */
export type Rounding = 'exact' | number;

export interface Client {
  id: string;
  name: string;
  rounding: Rounding;
  rate: number | null;
  /**
   * SDD-002 ruling 7: an ARCHIVED client is hidden from the surfaces you log NEW
   * work with, but keeps RESOLVING for history — the resolvers (clientOf/rateOf)
   * ignore this flag, so old reports/invoices are unchanged. Admin-owned by
   * construction (clients are already employee-403'd on write). Default false;
   * serialized additively (emit-when-true ` | archived` token, the ` | nb` discipline).
   */
  archived: boolean;
}

export interface Project {
  code: string;
  name: string;
  clientId: string | null;
  rate: number | null;
  /**
   * SDD-002: the billable default an entry inherits when it is first logged
   * against this project. A project is billable unless someone says otherwise,
   * and only an admin may change it (employees cannot edit projects — DD-003).
   * Changing it never re-bills logged history. Supersedes SB-011's task-level
   * default: the rule (admin-owned, derive-once, frozen) survives, the home moved.
   */
  billable: boolean;
  /**
   * SDD-002 ruling 7: an ARCHIVED project is hidden from creation pickers/templates
   * (you cannot log NEW work against it) but keeps RESOLVING for history — the
   * resolvers (projectOf/rateOf/projectBillable) ignore this flag, so old
   * reports/invoices are unchanged. Admin-owned by construction (projects are
   * already employee-403'd on write). Default false; serialized additively
   * (emit-when-true ` | archived` token, the ` | nb` discipline).
   */
  archived: boolean;
  /**
   * SB-059: the vault note this project is written as in the daily-note table. Set, the
   * `Project` cell renders `[[Lifelines Tycoon]]`; absent, it renders the bare code
   * (`LT-01`). A per-project field, deliberately NOT a column config — two projects in
   * one block can render differently, which a per-column switch cannot express.
   *
   * The value is the note NAME, without the brackets: TT composes `[[` … `]]` on write
   * and strips them on read, so a stored `[[X]]` would emit `[[[[X]]]]`.
   *
   * Reaches the bytes ONLY through the `projects` option of TT.serializeVaultBlock /
   * TT.parseVaultBlock / TT.writeVaultBlock. The v2 mirror serializes no token for it
   * (SB-069 froze those bytes), which also means it does not survive a mirror round-trip
   * yet — nothing produces one before SB-047/SB-056 wire a writer.
   */
  vaultNote?: string;
}

/**
 * SDD-002: a task is a per-user private TEMPLATE — a reusable stamp of
 * (label, project). Nothing about it is shared, and an entry never references it
 * after birth: logging an hour COPIES its label + project onto the entry.
 * Renaming or deleting a template never touches logged history.
 */
export interface Task {
  id: string;
  label: string;
  project: string | null;
}

export interface Entry {
  id: string;
  date: string;
  start: number | null;
  end: number | null;
  durMin: number | null;
  /**
   * SDD-002 copied-at-birth: `label` is the free text ("what I worked on") and
   * `project` the project code, both stamped permanently onto the entry — never
   * a link back to a template. `billable` is derived from the project default at
   * birth and frozen after (admin-only to change).
   */
  project: string | null;
  label: string;
  note: string;
  billable: boolean;
  /**
   * SDD-002 ruling 6 (SB-025): set when an admin corrected this line through the
   * cross-user review edit path — the 'edited by admin' marker. A plain boolean is
   * enough for the marker (richer per-admin attribution is YAGNI). Serialized
   * additively (emit-when-true `[ea]` token, the ` [nb]` discipline).
   */
  editedByAdmin?: boolean;
  /**
   * SB-059: the vault table's `Mode` column, as a real model field — `['#deep']`,
   * `['#admin']`. Before this it was carried raw on `VaultEntry.vaultCells.mode`, which
   * meant TT could re-emit a hand-typed `#deep` but could never read, filter or render it.
   *
   * VALUES ARE THE TOKENS AS WRITTEN, `#` INCLUDED. The alternative (store `deep`,
   * re-add the `#` on write) would force a normalisation ruling this ticket has no
   * mandate for — SB-045's own dataview regex accepts `#?(\w+)`, so a hand-written bare
   * `deep` is legal, and re-emitting it as `#deep` would rewrite Terje's bytes. Storing
   * the token verbatim keeps the round-trip byte-exact for every shape (`#deep`,
   * `deep`, `#work/deep`) and leaves the `#`-stripping question to the renderer (SB-047).
   *
   * OPTIONAL, and absent means "none" — the same discipline as `editedByAdmin`. An empty
   * `Mode` cell and a block with no `Mode` column both parse to absent, so a SQLite row
   * (which carries no tags today) is still an honest `Entry` and the db.js cast stays true.
   *
   * Multiple tags share one cell, space-separated (`#deep #admin`); a space INSIDE a tag
   * is escaped, which is why the cell has its own codec pair (TT.encodeTagsCell /
   * TT.decodeTagsCell) rather than a bare `join(' ')`.
   */
  tags?: string[];
}

/**
 * SB-063: which characters the VAULT daily note writes between a start and an end time.
 * `unicode` (`→`) is the default — an arrow everywhere, with no font dependency. `ascii`
 * (`->`) composes into a long-arrow ligature under JetBrains Mono / Fira Code / Cascadia and
 * degrades to two literal characters elsewhere, which is why it is not the default. `hyphen`
 * (`-`) matches the hand-written daily notes that predate the cutover.
 *
 * Write-side only: TT.parseTimeCell has accepted all three since SB-055, so changing this
 * never requires a vault migration.
 */
export type VaultTimeSeparator = 'unicode' | 'ascii' | 'hyphen';

// ---- storage backend (SB-056 / SDD-003) ----
/**
 * Which store holds the timesheet. `sqlite` is the repo default and the company deployment;
 * `vault` (DD-006) makes an Obsidian vault the source of truth, with SQLite demoted to a
 * derived index. Resolved server-side by `backendTarget()` — see `AppState.backend`.
 */
export type Backend = 'sqlite' | 'vault';

/**
 * What a backend is ALLOWED to do. Read at call time from `TT.backendCapabilities`, by the
 * server guards and the client surfaces alike, so a rule is a property of the BACKEND and
 * never of a path captured at switch time (DD-011).
 *
 *   `mirror`    — write the v2 `|`-delimited `timesheet-<user>.md`. Off under `vault`
 *                 (DD-011): the vault's daily notes are the markdown surface, and two
 *                 markdown representations of the same hours in one vault is the silent
 *                 divergence this map exists to kill.
 *   `committing`— freeze a week's money into the commit ledger. Off under `vault` (DD-008):
 *                 the ledger belongs in weekly notes, which are phase 3, and a per-machine
 *                 SQLite ledger under `vault` would diverge silently. Phase 3 restores it.
 *   `mdImport`  — paste a v2 mirror back INTO the database (Settings → Markdown backend).
 *                 Off under `vault` (DD-011) because it is a WRITE path into the store from
 *                 mirror bytes, and those bytes stop being maintained.
 */
export interface BackendCapabilities {
  mirror: boolean;
  committing: boolean;
  mdImport: boolean;
}

export interface Settings {
  currency: string;
  language: string;
  /** markdown mirror directory; only present server-side / for admins */
  mdDir?: string;
  /**
   * SB-056: which store holds the timesheet. INSTANCE-LOCAL — it, `mdDir` and `vaultPaths`
   * stay in SQLite under BOTH backends and must never be serialized into the catalog note
   * (SB-058), because they are how TT FINDS the catalog: putting them there is a bootstrap
   * loop.
   *
   * Reaches NO MIRROR BYTE. `TT.serializeMd` emits `currency:` / `language:` / `format: 2`
   * and nothing else — the same reason `mdDir` and `vaultTimeSeparator` have always been
   * invisible there — so no `format: 3` bump is in play (SB-069 stays intact) and a
   * paste-back that drops the key is harmless (`putSettings` writes only present keys).
   *
   * Absent behaves as `sqlite`. `TT_BACKEND` supplies the default and this stored value
   * beats it; `TT_BACKEND_LOCK` freezes the env value and rejects a change with 403 (DC-002,
   * the same shape as `TT_MD_DIR_LOCK`).
   */
  backend?: Backend;
  /**
   * SB-063: the vault daily note's Time-column separator; absent behaves as `unicode`.
   * Reaches the bytes ONLY through TT.serializeVaultBlock's `timeSeparator` option — the v2
   * mirror serializes no line for it and its output does not move when this changes (SB-069
   * froze those bytes).
   */
  vaultTimeSeparator?: VaultTimeSeparator;
}

/**
 * SDD-002 ruling 8: the money FROZEN onto one entry at the moment its segment is
 * committed — the resolved hourly rate, the billed minutes and the amount. Read
 * back for a committed entry so a later rate renegotiation never moves committed
 * history. Server-derived and server-frozen (an employee cannot produce these).
 */
export interface CommitSnapshotRow {
  rate: number;
  billMin: number;
  amount: number;
}

/**
 * SDD-002 ruling 4: an attested (ISO week ∩ month) SEGMENT and the money frozen
 * onto it. `key` is `${isoWeekYear}-W${pad2(week)}-${YYYY-MM}` (a month-straddling
 * week yields two independently committable segments); `committedAt` is a
 * server-stamped ISO string; `snapshot` maps entry id → the frozen per-entry money.
 *
 * SDD-002 ruling 5 (SB-025) admin lock/release — purely additive to format v2 (no
 * schema/format bump; tokens ride the `## commits` row only when present):
 *   `approvedAt` — server ISO stamp of when an admin LOCKED this segment; while set
 *     the employee can no longer un-commit it (Release clears it).
 *   `releasedBy` — admin user id that RELEASED the segment back for edits (Approve
 *     clears it). approvedAt and releasedBy are mutually exclusive by construction.
 */
export interface CommitSegment {
  key: string;
  committedAt: string;
  snapshot: Record<string, CommitSnapshotRow>;
  approvedAt?: string;
  releasedBy?: number;
}

/** One (ISO week ∩ month) slice of a week: its key, its calendar month, its days in order. */
export interface WeekSegment {
  key: string;
  month: string;
  dates: string[];
}

/** The full timesheet without a session user — what parseMd/serializeMd and the mirror carry. */
export interface Catalog {
  settings: Settings;
  clients: Client[];
  projects: Project[];
  tasks: Task[];
  entries: Entry[];
  /**
   * SDD-002 ruling 4: the caller's per-user commit ledger. Optional in the type
   * (server/client values built up incrementally) but ALWAYS present after parseMd,
   * which defaults it to `[]`; serializeMd emits a `## commits` section only when it
   * is non-empty, so v1 and no-commit v2 mirrors stay byte-identical.
   */
  commits?: CommitSegment[];
}

/**
 * Optimistic-concurrency counters (DC-001). `catalog` covers the shared
 * collections (settings/clients/projects); `entries` covers the session user's
 * own PER-USER data — their entries AND their task templates (SDD-002 moved
 * templates out of the shared catalog) — versioned separately so one admin's
 * catalog edit does not make every employee's save conflict.
 */
export interface StateVersion {
  catalog: number;
  entries: number;
}

/** Catalog plus the session user — the shape the client holds and /api/state returns. */
export interface AppState extends Catalog {
  user: User;
  version: StateVersion;
  /** DC-002: TT_MD_DIR_LOCK is set, so the mirror folder is env-only and read-only in the UI. */
  mdDirLocked?: boolean;
  /** SB-065: this user's mirror file changed under TT, so TT has stopped writing it. */
  mirrorBlocked?: MirrorBlock | null;
  /**
   * SB-056: the EFFECTIVE backend — what `backendTarget()` resolved, not what is stored. Read
   * by every client capability check (`TT.backendCapabilities(state.backend)`), which is why
   * it is reported rather than left to the client to re-derive from `settings.backend`: the
   * env and the lock can both beat the stored value.
   *
   * Additive and read-only. It is the one wire change SB-056 makes — "`backend=sqlite` comes
   * out byte-for-byte unchanged" is a claim about the DB and the mirror bytes, NOT the
   * envelope. Absent (an older server) behaves as `sqlite`.
   */
  backend?: Backend;
  /** DC-002: TT_BACKEND_LOCK is set, so the backend is env-only and read-only in the UI. */
  backendLocked?: boolean;
}

/**
 * SB-065: a mirror write TT refused because the file on disk is not the one it last wrote —
 * another machine or a human edited it. Sticky (it survives restarts and further saves) and
 * reported by /api/state, because a mirror that silently stops updating still LOOKS current;
 * cleared by POST /api/mirror/acknowledge, which is consent to overwrite on the next write.
 */
export interface MirrorBlock {
  /** absolute path of the file TT declined to write */
  path: string;
  /** when the mismatch was first seen */
  detectedAt: string;
  /** why: the file changed since TT's last write, or TT never wrote it at all */
  reason: string;
  /** when TT last wrote this path, if it ever did */
  lastWrittenAt: string | null;
}

// ---- vault block (SB-055 / SB-045) ----
/**
 * An entry as it comes out of (or goes into) a vault block. Identical to `Entry` plus the
 * phase-1 passthrough: vocabulary columns TT parsed but has no model field for, keyed by
 * the lowercased header label and holding the RAW (still-escaped) cell, so they are
 * re-emitted verbatim.
 *
 * SB-059 TOOK `Mode` OUT OF HERE — it is `Entry.tags` now, read and written like any other
 * modelled column. The passthrough itself stays: it is the mechanism SB-044's
 * settings-extended vocabulary lands on, and every column it adds arrives here first.
 * As of today NO column routes through it, so a parse never produces `vaultCells` at all.
 *
 * It is a SEPARATE type rather than an optional field on `Entry` deliberately. The sqlite
 * path casts query rows to `Entry` (server/src/db.js), and this field can never come out of
 * a SQLite row — putting it on the shared type both lies about that and breaks the cast.
 */
export interface VaultEntry extends Entry {
  vaultCells?: Record<string, string>;
}

/**
 * Every way TT can refuse a vault block. Enumerated rather than left as `string` so
 * SB-057's boot scan gets a compiler check when it switches on these — a typo'd reason
 * is otherwise silent, and the list would live only in a test.
 *
 * Structural (the locator): the two anchors, the `##` hard stop, the region's shape.
 * Schema and row level (the parser): the header vocabulary and each row's cells.
 * Output (the writer): the spliced result would not parse back.
 */
export type VaultQuarantineReason =
  // --- locator: the block cannot be bounded ---
  | 'no-heading'
  | 'crlf-line-endings'
  | 'multiple-headings'
  | 'no-revision'
  | 'revision-past-next-heading'
  | 'multiple-revisions'
  | 'no-table'
  | 'unexpected-content-in-block'
  /**
   * The bottom anchor's payload digest is present and does NOT match the table it labels —
   * DD-009. This is the one reason that means "the block is structurally fine and semantically
   * wrong": Obsidian's diff-merge (SB-051) keeps TT's anchor line and the buffer's rows, so
   * every other check passes. Never fires on a digest-less block, which is unverified, not
   * wrong.
   */
  | 'digest-mismatch'
  // --- parser: the schema or a row cannot be read ---
  | 'unknown-header'
  | 'duplicate-header'
  | 'row-cell-count'
  | 'unparseable-time'
  | 'bad-bill-cell'
  // --- writer: what TT would emit is not readable back ---
  | 'write-would-corrupt';

/**
 * The block was refused. `reason` is a stable code SB-057's boot scan can record and
 * surface. A quarantined block is NEVER written — quarantine, never guess.
 */
export interface VaultQuarantine {
  quarantine: true;
  reason: VaultQuarantineReason;
}

/**
 * A located vault block. All fields are 0-based LINE indices into `md.split('\n')`;
 * `start`..`end` (the `## <heading>` line through the `` `revision: N` `` line,
 * inclusive) is the only region TT may rewrite — everything outside it is Terje's.
 * `totalsLine` is -1 when the generated totals row is absent.
 */
export interface VaultBlockRegion {
  quarantine: false;
  /** the heading name actually matched (from opts, defaulting to `Time Log`) */
  heading: string;
  start: number;
  end: number;
  headerLine: number;
  separatorLine: number;
  rowLines: number[];
  totalsLine: number;
  revisionLine: number;
  revision: number;
  /**
   * The payload digest as found in the bottom anchor, or `null` on a digest-less line (DD-009).
   * A region is only ever returned when this is `null` or MATCHES — a present-and-wrong digest
   * quarantines as 'digest-mismatch'.
   */
  digest: string | null;
  /**
   * Did the block verify against its own payload? `false` means UNVERIFIED, not corrupt — a
   * pre-cutover or hand-made block carrying no digest (DD-009 consequence 2). SB-057's
   * arbitration matrix row 2 splits on this.
   */
  verified: boolean;
}

export type VaultBlockLocation = VaultBlockRegion | VaultQuarantine;

/**
 * A parsed vault block. `headers` is the block's OWN declared header labels, in its own
 * order and spelling — the serializer re-emits exactly these, which is what makes a
 * block written before a column existed keep round-tripping. Entries carry runtime ids
 * that are ephemeral by DD-008 and must never reach disk.
 */
export interface VaultBlockParse {
  quarantine: false;
  heading: string;
  revision: number;
  headers: string[];
  entries: VaultEntry[];
  /**
   * Propagated from the locator — see `VaultBlockRegion.verified` (DD-009). Forced `false` on an
   * adopted block: TT did not write those bytes, so nothing about them verifies.
   */
  verified: boolean;
  /**
   * DD-012: the note carried the anchor heading but no `` `revision: N` `` line, and TT
   * synthesised one because it could describe the whole region — so these entries were IMPORTED
   * from a block TT has never written. The note on disk is unchanged; adoption reaches disk only
   * through `writeVaultBlock`.
   */
  adopted: boolean;
}

export type VaultBlockParseResult = VaultBlockParse | VaultQuarantine;

// ---- parsed time cell (discriminated union) ----
export type ParsedTime =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'running'; start: number }
  | { kind: 'duration'; min: number };

export interface IsoWeek {
  week: number;
  year: number;
}

// ---- API contracts ----
export interface LoginRequest {
  email: string;
  password: string;
}
export interface LoginResponse {
  user: User;
}

/** GET /api/state — the logged-in application state (rates stripped for employees). */
export type StateResponse = AppState;

/**
 * PUT /api/state body — collection-replace patch; each key optional.
 * `version` is the optimistic-concurrency guard: send the version last read
 * from the server and a stale write is rejected with 409 instead of silently
 * clobbering a concurrent edit. Omitting it writes unconditionally (If-Match
 * semantics) — the client always sends it.
 */
export interface StatePatch {
  settings?: Settings;
  clients?: Client[];
  projects?: Project[];
  tasks?: Task[];
  entries?: Entry[];
  /**
   * SDD-002 ruling 4: which segments the caller has committed. The client sends
   * only `key` + a provisional `committedAt`; the server owns `committedAt` and the
   * per-entry snapshot and ignores any client-sent snapshot (an employee cannot
   * compute money). Rides the per-user `entries` version scope.
   */
  commits?: CommitSegment[];
  version?: StateVersion;
}

export interface PutStateResponse {
  ok: boolean;
  /** versions after this write — lets the client keep saving without a reload */
  version: StateVersion;
  mirror: string | null;
  mirrorError: string | null;
  /**
   * SB-065: the standing mirror refusal, if any. Present on the PUT response too (not only
   * on /api/state) so the client learns about it on the save that hit it — the save itself
   * still succeeded; only the mirror declined.
   */
  mirrorBlocked?: MirrorBlock | null;
}

/**
 * SB-086 — `POST /api/projects/:code/rename`. The one route that writes SEVERAL users'
 * mirrors in a single request (every user whose entries or templates moved, plus the acting
 * admin), so a single rename can leave more than one user's mirror in the sticky blocked
 * state. Hence a LIST where the one-mirror routes carry a single `mirrorBlocked`.
 *
 * Still a BLIND reconcile — no entry content crosses. A mirror path is not entry content:
 * the caller is an admin, who can already list users and knows the mirror folder.
 */
export interface ProjectRenameResponse {
  ok: boolean;
  /** the sticky blocks this rename hit, one per user whose mirror TT refused to write */
  mirrorBlocks: MirrorBlock[];
  /** every mirror failure, blocks included — a failure that is NOT a block appears only here */
  mirrorErrors: string[];
}

/**
 * SB-087 — `POST /api/clients/:id/rename`. A client rename is a pure CATALOG change:
 * `Project.clientId` is the only persisted reference to a client id, so no user's entries
 * or templates move and only the ACTING admin's mirror is rewritten. One mirror written
 * means the singular `mirrorBlocked` every other one-mirror route carries — the plural
 * shape belongs to the project rename, which really does write several (see PLAN-006 /
 * SB-086's `ProjectRenameResponse`).
 */
export interface ClientRenameResponse {
  ok: boolean;
  /** how many project rows were re-pointed at the new id */
  projects: number;
  mirror: string | null;
  mirrorError: string | null;
  mirrorBlocked?: MirrorBlock | null;
}

/** 409 body when a PUT loses the race; `version` is the server's current one. */
export interface ConflictResponse {
  error: string;
  conflict: true;
  version: StateVersion;
}

/**
 * One aggregated (person × project) bucket of the admin team report. Summed
 * server-side — other users' raw entries never reach the client.
 */
export interface TeamReportRow {
  userId: number;
  userName: string;
  /** project code, or null for entries with no project */
  project: string | null;
  /** the project's client, or null */
  clientId: string | null;
  /** minutes worked */
  min: number;
  /** billed minutes — rounded up per entry, non-billable excluded */
  bill: number;
  /** money, in the configured currency */
  amount: number;
  /** how many entries fell in this bucket */
  entries: number;
}

/** GET /api/reports/team — admin-only cross-user aggregate over an inclusive date range. */
export interface TeamReportResponse {
  /** the inclusive range echoed back; null means unbounded */
  from: string | null;
  to: string | null;
  rows: TeamReportRow[];
}

export interface UserCreateRequest {
  email: string;
  name: string;
  role?: Role;
  password: string;
}

/** POST /api/me/password — self-service change; the current password is the proof of identity. */
export interface PasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
}
/** POST /api/users/:id/password — admin reset; no current password, admin role is the proof. */
export interface PasswordSetRequest {
  password: string;
}

export interface OkResponse {
  ok: boolean;
}
/**
 * SB-065 / SB-085 — POST /api/mirror/acknowledge. `cleared` is false when there was no
 * block to clear (someone else got there first, or the caller guessed); `path` is the
 * mirror file whose on-disk bytes were adopted as the new stamp.
 */
export interface MirrorAcknowledgeResponse {
  ok: boolean;
  cleared: boolean;
  path: string;
}
export interface UsersResponse {
  users: User[];
}
export interface UserResponse {
  user: User;
}

// ---- the shared TT core singleton ----
// Method signatures for shared/core.js — the module is populated incrementally
// there, so core.js casts `{}` to this interface and each assignment is checked
// against it (contextual typing supplies the parameter types).
export interface TTModule {
  // formatters
  fmtT(min: number): string;
  fmtDur(min: number): string;
  fmtHours(min: number): string;
  fmtMoney(n: number, cur?: string): string;
  // time cell
  parseTimeCell(raw: string): ParsedTime | null;
  /**
   * SB-063: `separator` is a Settings.vaultTimeSeparator VALUE NAME (never raw characters),
   * defaulting to `unicode` — today's `→` — for every caller that does not pass one. Only
   * TT.serializeVaultBlock does; the v2 mirror and the UI keep the default.
   */
  fmtTimeCell(entry: Entry, separator?: VaultTimeSeparator): string;
  /** SB-063: value name → the characters to emit; absent/unrecognised → `→`. */
  timeSeparator(name?: string | null): string;
  /** SB-063: the legal Settings.vaultTimeSeparator values, default first. */
  TIME_SEPARATOR_VALUES: string[];
  // backend capabilities (SB-056)
  /** SB-056: the legal Settings.backend values, safe default first. The ONE home of this list. */
  BACKENDS: Backend[];
  /** SB-056: what a backend may do. Consulted at CALL TIME by server guards and client surfaces alike. */
  backendCapabilities(backend?: string | null): BackendCapabilities;
  nowMin(): number;
  isRunning(entry: Entry): boolean;
  entryMinutes(entry: Entry): number;
  // dates
  todayStr(): string;
  dateStr(d: Date): string;
  parseDate(s: string): Date;
  addDays(s: string, n: number): string;
  isoWeek(s: string): IsoWeek;
  weekDates(anchor: string): string[];
  // SDD-002 ruling 4: (ISO week ∩ month) commit segments
  segmentKey(dateStr: string): string;
  weekSegments(anchor: string): WeekSegment[];
  fmtDayLong(s: string): string;
  fmtDayShort(s: string): string;
  fmtMonth(ym: string): string;
  // billing / lookups
  roundBill(min: number, rounding: Rounding): number;
  projectOf(state: Catalog, code: string | null): Project | null;
  projectBillable(state: Pick<Catalog, 'projects'>, code: string | null): boolean;
  entryProjectCode(state: Catalog, entry: Entry): string | null;
  slug(s: string): string;
  clientOf(state: Catalog, project: Project | null): Client | null;
  rateOf(state: Catalog, code: string | null): number;
  billMinutes(state: Catalog, entry: Entry): number;
  amount(state: Catalog, entry: Entry): number;
  // SDD-002 ruling 8: snapshot-preferring readers — frozen money for a committed
  // entry, live money otherwise. `commitSnapshot` returns the frozen row or null.
  commitSnapshot(state: Catalog, entry: Entry): CommitSnapshotRow | null;
  effectiveBillMinutes(state: Catalog, entry: Entry): number;
  effectiveAmount(state: Catalog, entry: Entry): number;
  // SDD-002 ruling 5/6 (SB-025): review rollup — is a stored segment locked, and the
  // per-segment committed/approved status of a month (reused by the review pills + nav badge).
  segmentApproved(seg: CommitSegment | null | undefined): boolean;
  monthSegments(state: Catalog, month: string): { key: string; committed: boolean; approved: boolean }[];
  monthGood(state: Catalog, month: string): boolean;
  projColor(state: Catalog, code: string | null): string;
  // markdown — cell escaping (SB-041). A shared primitive, not a parseMd internal:
  // the vault table serializer (SB-055) escapes its own cells with the same pair.
  // encodeCell handles `\` and `|`; encodeNoteCell adds the trailing [nb]/[ea] run,
  // which only the note field can collide with. decodeCell reverses all three.
  encodeCell(s: string): string;
  encodeNoteCell(note: string): string;
  decodeCell(s: string): string;
  /**
   * SB-071 (PLAN-009 task 1): the READ half of the codec. Splits on UNESCAPED
   * occurrences of `delim` only and returns the pieces STILL escaped — the caller
   * reads structure out of them (rule tokens, flag markers) and decodes last, or a
   * `\[nb]` gets eaten. Public so the vault table parser (SB-055) shares the one
   * implementation of the escape rule with the v2 mirror instead of copying it.
   */
  splitUnescaped(s: string, delim: string, trim?: boolean): string[];
  /** Split a `|`-delimited row body into its trimmed, still-escaped cells. */
  splitCells(s: string): string[];
  // SB-045: the vault `Task` column holds `label<br>- note` in ONE cell. `<br>` is a
  // structural delimiter and `- ` is presentation — both escaped/stripped here so they
  // survive as content. Composes on top of encodeCell; consumed by SB-055.
  encodeTaskCell(v: { label?: string; note?: string }): string;
  decodeTaskCell(cell: string): { label: string; note: string };
  /**
   * SB-059: the vault `Mode` column's codec — `Entry.tags` ⇄ one cell. Composes on top of
   * encodeCell exactly as encodeTaskCell does, with the space as its structural delimiter
   * instead of `<br>`: a tag containing a space is escaped, so it cannot become two tags.
   * Encode trims each tag and drops the empties (a cell is trimmed on read, so a leading
   * or trailing space could never survive anyway).
   */
  encodeTagsCell(tags?: string[] | null): string;
  decodeTagsCell(cell: string): string[];
  /**
   * SB-055: locate the vault block between its two anchors — the `## <heading>` line
   * (name from `opts.heading`, default `Time Log`) and the `` `revision: N` `` line —
   * or return a quarantine verdict. Never throws, and never returns a region it is
   * unsure of: this is what stops a write from running into the rest of the note.
   */
  /**
   * The payload digest a vault block's bottom anchor carries (DD-009). Input is the payload
   * LINES — header row, delimiter row, data rows — not a note and not a region. 4 lowercase hex.
   */
  vaultPayloadDigest(payloadLines: string[]): string;
  locateVaultBlock(md: string, opts?: { heading?: string }): VaultBlockLocation;
  /**
   * SB-055: parse the located block into entries. The header row is the schema; any
   * SUBSET of the canonical-English vocabulary (`Time`, `Mode`, `Project`, `Task`,
   * `Bill`) in any ORDER parses, anything outside it quarantines. `opts.date` supplies
   * the note's date — SB-045's format has no date column.
   *
   * SB-059: `opts.projects` is the catalog used to resolve a `[[Wikilink]]` Project cell
   * back to its project CODE (matched on `Project.vaultNote`). Absent — or no project
   * claiming that note — the cell is carried verbatim, exactly as before SB-059.
   *
   * DD-012: a note carrying the anchor heading but no bottom anchor is ADOPTED first, provided
   * everything between the heading and the next `##` (or EOF) is empty or a single well-formed TT
   * table — so its rows come back as entries, flagged `adopted: true` and never `verified`. This
   * reads only; nothing is written. A missing bottom anchor is therefore no longer a refusal on
   * its own, and 'no-revision' is a `locateVaultBlock`-only verdict.
   */
  parseVaultBlock(md: string, opts?: { heading?: string; date?: string; projects?: Project[] }): VaultBlockParseResult;
  /**
   * SB-055: the block's region bytes — the `## <heading>` line through the
   * `` `revision: N` `` line, no trailing newline. Header row always, totals row always
   * (generated, never round-tripped as an entry), `opts.headers` defaulting to the
   * canonical five.
   *
   * SB-059: `opts.projects` turns an entry's project CODE into the `[[vaultNote]]` the
   * `Project` column renders. Absent — or the code has no project, or that project has no
   * `vaultNote` — the code is written bare, exactly as before SB-059.
   */
  serializeVaultBlock(
    entries: VaultEntry[],
    opts?: {
      heading?: string;
      headers?: string[];
      revision?: number;
      timeSeparator?: VaultTimeSeparator;
      projects?: Project[];
    },
  ): string;
  /**
   * SB-055: splice the serialized block back into its host note. Every byte outside the
   * located region survives untouched. On a quarantine verdict the input `md` is
   * returned byte-identical — it is impossible to write from a quarantined block. The
   * revision is not bumped here; that is SB-057's arbitration.
   *
   * DD-012: a note with the anchor heading and no bottom anchor is ADOPTED rather than refused
   * when TT can describe its whole region, and `adopted` says so. That first write has no prior
   * `(rev, hash)` in SB-057's index at all — a new arbitration row, not a variant of an existing
   * one. `adopted` is false on every refusal, since a refusal writes nothing.
   */
  writeVaultBlock(
    md: string,
    entries: VaultEntry[],
    opts?: {
      heading?: string;
      date?: string;
      headers?: string[];
      revision?: number;
      timeSeparator?: VaultTimeSeparator;
      projects?: Project[];
    },
  ): { md: string; quarantine: boolean; reason: VaultQuarantineReason | null; adopted: boolean };
  serializeMd(state: Catalog): string;
  newId(): string;
  parseMd(md: string): Catalog;
  newEntry(date: string, parsed?: ParsedTime | null): Entry;
  seedMd(): string;
  seed(): Catalog;
  // i18n (installed by client/src/i18n.ts at runtime; date formatters overridden)
  lang: string;
  t(s: string): string;
}
