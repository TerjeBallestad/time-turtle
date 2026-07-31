// @ts-check
//
// ============================================================================================
// THE FOUR INVARIANTS (SB-057) — "what keeps a parser bug from eating real hours"
// ============================================================================================
// In their CURRENT wording. Two of them have moved since SB-057's body was written, and each is
// restated here rather than left standing next to code that does something else. Every one is
// pinned by its own describe block in tests/vault-invariants.test.js.
//
// 1. UNREADABLE OR ABSENT → `unknown`, NEVER `empty`. TT never infers a deletion from a file it
//    could not read.
//    WHAT SB-052 CHANGED ABOUT THIS: eviction is NOT what this defends against. An evicted file is
//    readable — via a ~1 s blocking download — so it never presents as absent or unreadable, and
//    believing this invariant covered it is precisely why nobody would build the timeout. What it
//    does cover: a genuine partial-sync state, a permissions failure, and an offline read that
//    times out. Keep the invariant; stop describing it as the eviction defence.
//
// 2. AN UNPARSEABLE BLOCK IS QUARANTINED, SURFACED, AND LEFT ALONE — never overwritten.
//    DD-014's rider: quarantine rather than write a DEGRADED cell. The vault block is a lossless
//    carrier of a TT entry because `personal → team` is the upgrade path, and losing history on
//    the way in is the one stranding nobody survives.
//
// 3. TT NEVER WRITES OUTSIDE ITS OWN MARKERS. `TT.locateVaultBlock` bounds the region
//    (`start..end` inclusive, hard-stopping at the next ATX heading) and `writeVaultBlock` splices
//    only that range. Intentions, Habits, Captures and Reflection are Terje's.
//
// 4. RESTATED — the old wording is superseded TWICE, by SB-045's heading-anchoring and then by
//    DD-012's adoption. SDD-003 said "TT only claims a note that already has a block or that TT
//    created for the purpose". The rule TT actually follows now:
//
//        TT claims a note that carries the anchor heading EXACTLY ONCE and whose region between
//        that heading and the next `##` (or EOF) TT can describe COMPLETELY — empty, or a single
//        well-formed TT table and nothing else. On first write TT writes the bottom anchor itself.
//        Anything else it refuses and leaves alone.
//
//    The heading name comes from `Settings.vaultPaths.timeLogHeading` and is never a constant.
//
//    THE CONSEQUENCE TERJE SHOULD NOT HAVE TO REDISCOVER: his Templater daily template puts
//    `## Time Log` in EVERY daily note, so under this rule every daily note is claimable —
//    bounded only by the header vocabulary. That vocabulary is what keeps SB-049's 60 pre-cutover
//    notes closed: they carry `| Time | Cat | Project | Description |`, which is not TT's schema.
//    SB-044 (a settings-extended vocabulary) is therefore LOAD-BEARING for SB-049 — adding `Cat`
//    and `Description` to it would open all 60 to adoption in one commit. SB-091 left a test that
//    goes red if that happens. Do not weaken it.
//
// ---- THE SYNC ENGINE (SB-057) ----
//
// Three triggers, one per-file pass. This is where the filesystem lives; `vault-arbitrate.js`
// stays pure and this module feeds it.
//
// THE PER-FILE PASS, in order, and every step of it is a cost decision:
//   1. `statSync` — free, and it CLASSIFIES. An iCloud-evicted file is not a `.icloud` stub: it
//      keeps its real filename and reports its full size, and is DATALESS (`blocks === 0` with
//      `size > 0`). SB-052 measured that `statSync` does not trigger a download, so this costs
//      nothing.
//   2. dataless → record `unknown` and DO NOT READ. A read succeeds, via a blocking transparent
//      download that took 1069 ms for 19 KB — so 200 evicted days is a ~3-minute `tt serve`
//      startup that reads as a hang, on a process that spawns detached and would not even show
//      you where it stalled.
//   3. read, with a TIMEOUT. SB-052 could not safely drop the network and carried the offline
//      behaviour as an explicit residual unknown: a blocking download with no network either
//      errors or hangs indefinitely. A timeout yields `unknown`, the same verdict as unreadable,
//      and therefore never a write.
//   4. hash the whole file, compare to the index, SKIP IF UNCHANGED. This is what makes the slow
//      interval free on a quiet day.
//   5. parse → `arbitrate` → apply.
//
// THE INTERVAL RUNS THE SAME PASS, dataless check included. That was an open question on the
// ticket and this is the answer: one `statSync` either way, and hashing evicted files instead
// would materialise them — turning the first interval passes on a cold machine into a download
// storm, and, after DD-019, into a 409 against an open tab for each one.
//
// EVERY IMPORT BUMPS THE `entries` VERSION (DC-001, design decision 10). `putEntries` is
// DELETE-all-then-insert and the client PUTs its whole entry set on every debounce, so an import
// that did not invalidate the client's version would be silently overwritten by the client's next
// save — and the writer would then put an empty block over a day whose rows it had just imported.
// What the client DOES about the bump is DD-019/SB-118's, not this module's; `useServerSync` is
// not touched here.
//
// THE ECHO GUARD IS A DE-DUPLICATION CONVENIENCE, and nothing more. DD-009 took integrity off it
// (the digest lives on the note) and DD-019 ruling 3 took ergonomics off it too (SB-117 preserves
// runtime ids, so a missed echo costs an invisible reload and at most one debounce). It is built
// plainly and there is deliberately no second mechanism behind it.
import { statSync, readFileSync, readdirSync, watch } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import TT from '../../shared/core.js';
// db.js DIRECTLY, and not through `store.js` — this module is INSIDE the seam, not a caller of it.
// `store.js` dispatches the vault implementation, so going back through it would be a cycle
// (store → vault-write → vault-sync → store); server/src/markdown.js imports db.js for the same
// reason, spelled out at its own import site. It matters in one place beyond the cycle: the import
// path writes entries with `db.putEntries`, which deliberately does NOT trigger the vault write
// fan-out — the file it came from is already the authority, and re-writing it would be TT echoing
// its own import back at itself.
//
// `listUsers` is identity, which the seam excludes anyway. Under `personal` the user table holds
// exactly one row (DD-006 consequence 1), which is what makes "the user" a well-defined thing for
// an import to belong to.
import * as db from './db.js';
import { listUsers } from './db.js';
import { activeBackend } from './backend.js';
import { arbitrate, describeVaultCatalogFile, describeVaultFile, fileSha } from './vault-arbitrate.js';
import { sweepVaultTemps } from './vault-fs.js';

/** @typedef {import('../../shared/types.ts').Entry} Entry */
/** @typedef {import('../../shared/types.ts').VaultIndexRow} VaultIndexRow */

/**
 * How long TT waits for a vault read before calling the day `unknown` (design decision 13).
 *
 * SB-052's residual unknown, made into a number rather than an assumption: with the network down,
 * a transparent download either errors or blocks indefinitely, and nobody has been able to test
 * which. Generous against a warm read (which is sub-millisecond) and against a materialisation
 * that has already started (1069 ms for 19 KB), tight enough that a hung boot scan still finishes.
 */
export const VAULT_READ_TIMEOUT_MS = 5000;
/**
 * The watcher's debounce. Two reasons for ~500 ms: an editor save is several fs events, and iCloud
 * lands a file in pieces. Whether it is long ENOUGH for an iCloud landing is not knowable from
 * this machine — that is the gate ticket task 9 files, and it is why the interval below exists as
 * a second trigger rather than as belt and braces.
 */
export const WATCH_DEBOUNCE_MS = 500;
/**
 * The slow interval — the SECOND trigger, because iCloud sometimes lands a file without a
 * watchable event. Costs one `statSync` per daily note on a quiet day and nothing else.
 */
export const SCAN_INTERVAL_MS = 60_000;

/** `YYYY-MM-DD.md` — the only filename shape TT reads a date out of. */
const DAILY_NOTE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

// ---- the own-write echo record ----
/** @type {Map<string, { sha: string, rev: number | null }>} */
const echo = new Map();
/**
 * Remember that TT itself just wrote these bytes, so the watcher event they cause is a no-op.
 * Called by the writer immediately after a successful `writeVaultFile`.
 * @param {string} path @param {string} sha @param {number | null} [rev]
 */
export function noteOwnWrite(path, sha, rev) {
  echo.set(path, { sha, rev: rev == null ? null : rev });
}
/** Drop everything remembered — test teardown, and a settings change that re-points the vault. */
export function forgetOwnWrites() {
  echo.clear();
}

// ---- the rewriter seam (filled by server/src/vault-write.js) ----
/** @type {(date: string, rev: number) => void} */
let rewriter = () => {};
/**
 * Two verdicts need a WRITE — `import-and-rewrite` and `rewrite-from-index` — and the writer lives
 * one module over. Registered rather than imported so the dependency runs one way: the writer
 * imports this module (for `noteOwnWrite`), and this module never imports the writer. A no-op
 * default means the scan is complete and correct on its own; it just declines to write.
 * @param {(date: string, rev: number) => void} fn
 */
export function setVaultRewriter(fn) {
  rewriter = typeof fn === 'function' ? fn : () => {};
}
/** @type {(rev: number) => void} */
let catalogRewriter = () => {};
/**
 * The same seam for the Catalog (PLAN-017). Registered rather than imported, so the dependency
 * still runs one way, and a no-op default so the READ path is complete and correct on its own —
 * which is exactly the state task 1 leaves the tree in, deliberately: it reads the note and
 * declines to write it.
 * @param {(rev: number) => void} fn
 */
export function setVaultCatalogRewriter(fn) {
  catalogRewriter = typeof fn === 'function' ? fn : () => {};
}

// ---- configuration ----
/**
 * Where the vault is, what TT is allowed to look at inside it, and who the entries belong to.
 * Resolved on every pass rather than captured at boot: `vaultPaths` is a setting, and a scan that
 * kept scanning the old folder after the user re-pointed it would be reading somebody else's
 * vault. Same discipline `mirrorTarget()` follows for DD-011.
 *
 * `null` means "there is nothing to sync": not the `personal` shape, or no vault root configured.
 * A missing root is emphatically NOT "scan from the current directory".
 * @returns {{ root: string, dailyDir: string, catalogPath: string, heading: string, cutoverDay: string, userId: number, projects: import('../../shared/types.ts').Project[], timeSeparator: any } | null}
 */
export function vaultSyncConfig() {
  if (activeBackend() !== 'vault') return null;
  const settings = db.getSettings();
  const paths = settings.vaultPaths || TT.VAULT_PATHS_DEFAULT;
  if (!paths.root) return null;
  const users = listUsers();
  if (users.length !== 1) return null; // DD-006 consequence 1; the boot guard already refuses this
  return {
    // SB-068 needs the ROOT, not the daily folder: the checkpoint is `git add -A` against the
    // whole vault worktree, and a checkpoint of `Calendar/Daily` is not a checkpoint of the vault.
    root: paths.root,
    dailyDir: join(paths.root, paths.daily),
    // PLAN-017 task 1: the Catalog note, resolved on every pass for the same reason the daily
    // folder is — `vaultPaths.catalog` is a setting, and a pass that kept reading the old path
    // after the user re-pointed it would be resolving rates out of somebody else's note.
    catalogPath: join(paths.root, paths.catalog || TT.VAULT_PATHS_DEFAULT.catalog),
    heading: paths.timeLogHeading || TT.VAULT_PATHS_DEFAULT.timeLogHeading,
    // DD-016 is worded as an INSTANT and `Entry.date` is a day, so the comparison is day-grained —
    // `stampVaultCutover` stores the finer value precisely so this can choose. `''` (never
    // stamped) reads as "no cutover", which lets everything through; that only happens outside the
    // personal shape, where this function has already returned null.
    cutoverDay: (settings.vaultCutover || '').slice(0, 10),
    userId: users[0].id,
    // SB-059: the catalog the Project column resolves through. Absent it, a `[[Wikilink]]` cell is
    // carried literally, which is the pre-SB-059 behaviour and never a refusal.
    projects: db.getProjects(),
    timeSeparator: settings.vaultTimeSeparator,
  };
}

/**
 * Is this date inside the vault's history at all?
 *
 * DD-016's cutover, applied to the READ direction as well as the write. Its words are "no vault
 * write, no DD-012 adoption for entries dated before it" — and an import of an adopted note IS
 * DD-012 adoption, so a pre-cutover daily note is not TT's to claim. The write half of the same
 * rule (`vaultBound`) lives in shared/core.js, because it also has to answer for the ledger.
 * @param {string} date @param {string} cutoverDay @returns {boolean}
 */
export function afterCutover(date, cutoverDay) {
  return !cutoverDay || date >= cutoverDay;
}

// ---- the file classifier ----
/**
 * What `statSync` can tell TT for free.
 *
 * DATALESS is the real shape of an iCloud eviction (SB-052, measured on the real vault): the
 * filename is unchanged, the size is the full size, and only `blocks === 0` gives it away. There
 * is no `.icloud` sibling to look for, and `st_flags` carries `SF_DATALESS` (0x40000000) if you
 * drop to native — which Node does not expose, and does not need to.
 *
 * `statSync` does NOT trigger a download: SB-052 verified it by stat-ing an evicted file
 * repeatedly and watching `blocks` stay at 0. That is the whole reason classification can be
 * eager while reading is lazy.
 * @param {string} path @param {(p: string) => any} [stat]
 * @returns {{ exists: boolean, size: number, blocks: number, dataless: boolean }}
 */
export function classifyVaultFile(path, stat) {
  try {
    const s = (stat || statSync)(path);
    const size = Number(s.size) || 0;
    const blocks = Number(s.blocks) || 0;
    return { exists: true, size, blocks, dataless: size > 0 && blocks === 0 };
  } catch {
    return { exists: false, size: 0, blocks: 0, dataless: false };
  }
}

/**
 * Read a note, or give up. A timeout is `readable: false` — the same verdict as unreadable and as
 * absent, because all three mean "TT has not confirmed reading this day", which is exactly what
 * the write scope rule refuses to write to.
 *
 * `Promise.race` and not a signal: the underlying read is a blocking materialisation inside libuv,
 * and nothing cancels it. What the timeout buys is that the SCAN moves on — the day is recorded
 * `unknown` and the next pass will try again, rather than the boot hanging on a file that will
 * never arrive.
 * @param {string} path @param {{ readFile?: (p: string) => Promise<string>, timeoutMs?: number }} [io]
 * @returns {Promise<{ readable: boolean, text: string | null, timedOut: boolean }>}
 */
export async function readVaultNote(path, io) {
  const read = (io && io.readFile) || ((p) => readFileAsync(p, 'utf8'));
  const timeoutMs = (io && io.timeoutMs) || VAULT_READ_TIMEOUT_MS;
  /** @type {any} */
  let timer = null;
  const TIMED_OUT = Symbol('timed-out');
  try {
    const raced = await Promise.race([
      read(path).then((text) => /** @type {any} */ ({ text })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (raced === TIMED_OUT) return { readable: false, text: null, timedOut: true };
    return { readable: true, text: String(raced.text), timedOut: false };
  } catch {
    return { readable: false, text: null, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- applying a verdict ----
/**
 * The index row a verdict leaves behind, and the one place its defaults are written. Shared by the
 * daily note and the Catalog (PLAN-017 task 1) so a field added to the row cannot be remembered on
 * one path and forgotten on the other.
 *
 * NOTHING HERE DELETES ANYTHING ON A VERDICT OF `unknown`. That is invariant 1 on the write side:
 * the row keeps its `rev`, its digest and everything TT already holds, and only `state` and
 * `seenAt` move. A file TT could not read is one TT knows nothing new about — never an empty one.
 * @param {string} path @param {string} date `''` for the Catalog, which is not a day (TERM-004)
 */
function indexWriterFor(path, date) {
  const existing = db.getVaultIndex(path);
  const seenAt = new Date().toISOString();
  /** @param {Partial<VaultIndexRow>} over */
  const write = (over) =>
    db.putVaultIndex(
      /** @type {VaultIndexRow} */ ({
        path,
        date,
        state: 'unknown',
        rev: existing ? existing.rev : null,
        payloadDigest: existing ? existing.payloadDigest : null,
        fileSha: existing ? existing.fileSha : null,
        verified: existing ? existing.verified : null,
        quarantineReason: null,
        quarantineSection: null,
        seenAt,
        writtenAt: existing ? existing.writtenAt : null,
        ...over,
      }),
    );
  return { existing, write };
}

/**
 * What one daily note's verdict does — the index row it leaves behind, plus, for the two importing
 * verdicts, the entries it puts into the index and the version bump that tells the client.
 * @param {string} path @param {string} date
 * @param {import('../../shared/types.ts').VaultArbitrationVerdict} verdict
 * @param {{ userId: number, sha?: string | null, payloadDigest?: string | null, parse?: any }} ctx
 */
export function applyVerdict(path, date, verdict, ctx) {
  const { existing, write } = indexWriterFor(path, date);

  switch (verdict.verdict) {
    case 'skip':
      // Nothing moved. `seenAt` moves so a quiet day is visibly still being watched, and the sha
      // is refreshed for a row that had none (the first pass after an index rebuild).
      write({ state: existing ? existing.state : 'known', fileSha: ctx.sha ?? (existing && existing.fileSha) });
      return;
    case 'unknown':
      write({ state: 'unknown' });
      return;
    case 'quarantine':
      // The sha IS recorded, deliberately: the next pass's cheap exit then skips the file without
      // re-parsing it, and the quarantine stays sticky and visible until the bytes actually change.
      write({ state: 'quarantined', quarantineReason: verdict.reason ?? null, fileSha: ctx.sha ?? null });
      return;
    case 'import':
    case 'import-and-rewrite': {
      importEntries(ctx.userId, date, ctx.parse ? ctx.parse.entries : []);
      // THE ROW RECORDS WHAT IS ON DISK RIGHT NOW — the file's own revision, not the verdict's.
      //
      // They differ only on `import-and-rewrite`, where `verdict.rev` is `fileRev + 1`: the
      // revision the file is about to be REWRITTEN to. Storing that against the digest of the
      // payload at `fileRev` would put a pair in the row that no note ever carried, and the
      // rewriter's own write would then roll THAT fabricated pair into `prev_rev`/
      // `prev_payload_digest`. The damage is quiet and specific: `prevRev` would equal `rev`, so
      // arbitration branch (a) — the provably-stale peer — could never match for this path again,
      // and a peer that is genuinely one revision behind would quarantine as
      // `unprovable-staleness` instead of being caught up. It fails safe, and it disables the one
      // branch SB-061 had this ticket built for. The rewriter moves the pair honestly, one step
      // later, from bytes that exist.
      write({
        state: 'known',
        rev: ctx.parse && ctx.parse.revision != null ? ctx.parse.revision : (verdict.rev ?? null),
        payloadDigest: ctx.payloadDigest ?? null,
        fileSha: ctx.sha ?? null,
        verified: ctx.parse ? !!ctx.parse.verified : null,
      });
      if (verdict.verdict === 'import-and-rewrite' && verdict.rev != null) rewriter(date, verdict.rev);
      return;
    }
    case 'rewrite-from-index':
      // No import: the file is provably behind, so its rows are TT's own older ones. The index is
      // already right; the FILE is what needs fixing, and the writer is what fixes it.
      //
      // The row is touched FIRST, and that is not bookkeeping. If the rewrite is refused, nothing
      // else here would record that TT had looked — and the next interval would re-read, re-parse
      // and re-arbitrate this note, silently, every 60 s forever. Recording `seenAt` and the file's
      // sha means an unfixable note takes the cheap exit on the following pass instead.
      write({ state: existing ? existing.state : 'known', fileSha: ctx.sha ?? (existing && existing.fileSha) });
      if (verdict.rev != null) rewriter(date, verdict.rev);
      return;
    default:
      return;
  }
}

/**
 * Put one day's imported rows into the index, replacing exactly that day and nothing else.
 *
 * `putEntries` is a whole-collection replace, so the day is spliced into the user's current set
 * here rather than there. Every other date comes back byte-identical — including the days a scan
 * skipped as dataless, which is the same rule the writer follows on its side.
 *
 * SB-117 / DD-019 ruling 3: rows whose content is unchanged KEEP the runtime id the index already
 * holds for them. The parse minted a fresh `nid()` for every row (DD-008 — the runtime id is
 * ephemeral), and handing those straight to `putEntries` remounted every grid row on the imported
 * day, destroying whatever `NoteCell` draft was open. Only genuinely-changed rows carry their new
 * id through. The matching rule and why its field set is what it is live on `TT.preserveEntryIds`.
 *
 * ONE `getEntries` CALL FEEDS BOTH HALVES — the split is by date, so the same read that supplies
 * the other days supplies the day's existing rows. Inside the transaction, so the rows matched
 * against are the rows replaced.
 * @param {number} userId @param {string} date @param {Entry[]} entries
 */
function importEntries(userId, date, entries) {
  db.transaction(() => {
    const held = db.getEntries(userId);
    const others = held.filter((entry) => entry.date !== date);
    const sameDay = held.filter((entry) => entry.date === date);
    const imported = TT.preserveEntryIds(
      (entries || []).map((entry) => ({ ...entry, date })),
      sameDay,
    );
    db.putEntries(userId, others.concat(imported));
    // DC-001, design decision 10. Without this the client's next whole-set PUT silently overwrites
    // what was just imported.
    db.bumpEntriesVersion(userId);
  });
}

// ---- the catalog (PLAN-017 task 1, DD-020) ----
/**
 * What one Catalog verdict does. The daily note's `applyVerdict` one file over, over a different
 * store: clients, projects and task templates instead of entries, and the `catalog` version
 * counter instead of `entries`.
 *
 * THE `date` IS `''` AND THAT IS THE HONEST VALUE. The Catalog holds state that is not a day
 * (TERM-004), so there is no date it could carry, and every date-keyed reader asks for a real day.
 * @param {string} path @param {import('../../shared/types.ts').VaultArbitrationVerdict} verdict
 * @param {{ userId: number, sha?: string | null, file?: any }} ctx
 */
export function applyCatalogVerdict(path, verdict, ctx) {
  const { existing, write } = indexWriterFor(path, '');
  const parse = ctx.file ? ctx.file.parse : null;

  switch (verdict.verdict) {
    case 'skip':
      write({ state: existing ? existing.state : 'known', fileSha: ctx.sha ?? (existing && existing.fileSha) });
      return;
    case 'unknown':
      write({ state: 'unknown' });
      return;
    case 'quarantine':
      // The SECTION rides with the reason. A catalog refusal shares most of its vocabulary with a
      // daily block (`unknown-header`, `row-cell-count`, `digest-mismatch`), so a reason naming
      // neither a day nor a section is one a person cannot go and look at.
      write({
        state: 'quarantined',
        quarantineReason: verdict.reason ?? null,
        quarantineSection: parse ? parse.section : null,
        fileSha: ctx.sha ?? null,
      });
      return;
    case 'import':
    case 'import-and-rewrite': {
      importCatalog(ctx.userId, parse && parse.catalog);
      // The same honesty rule the daily note follows: the row records the revision that is ON DISK
      // right now, never the one a rewrite is about to move it to. See `applyVerdict`.
      write({
        state: 'known',
        rev: parse && parse.revision != null ? parse.revision : (verdict.rev ?? null),
        payloadDigest: ctx.file ? ctx.file.payloadDigest : null,
        fileSha: ctx.sha ?? null,
        verified: parse ? !!parse.verified : null,
      });
      if (verdict.verdict === 'import-and-rewrite' && verdict.rev != null) catalogRewriter(verdict.rev);
      return;
    }
    case 'rewrite-from-index':
      write({ state: existing ? existing.state : 'known', fileSha: ctx.sha ?? (existing && existing.fileSha) });
      if (verdict.rev != null) catalogRewriter(verdict.rev);
      return;
    default:
      return;
  }
}

/**
 * Put the note's catalog into SQLite — DD-006's derived index, filled from the file that IS the
 * database under `personal`.
 *
 * THE SETTINGS ROWS GO THROUGH `TT.vaultCatalogSettings` AND NOTHING ELSE. It is the allowlist
 * projection: a key this TT does not know is carried on the rows and re-emitted, never applied.
 * Handing `Object.fromEntries(rows)` to `putSettings` instead would let a note reach in and set
 * `shape`, `vaultPaths` or `mdDir` — the three settings that say how TT FINDS this note.
 *
 * ONE TRANSACTION, because a catalog that landed its projects and not its clients resolves every
 * rate to 0 with no error anywhere. Whole-catalog atomicity is what the codec refuses partial
 * parses for; it would mean nothing if the apply were piecemeal.
 * @param {number} userId @param {import('../../shared/types.ts').VaultCatalog | null} catalog
 */
function importCatalog(userId, catalog) {
  if (!catalog) return;
  db.transaction(() => {
    db.putClients(catalog.clients || []);
    db.putProjects(catalog.projects || []);
    db.putTasks(userId, catalog.tasks || []);
    db.putSettings(TT.vaultCatalogSettings(catalog.settings || []));
    // DC-001: without the bump an open tab keeps its stale catalog and PUTs it straight back over
    // what was just imported — the same trap `importEntries` closes for a day's rows.
    db.bumpCatalogVersion();
  });
}

/**
 * Look at the Catalog note and do whatever it deserves. The same pass a daily note gets.
 * @param {ReturnType<typeof vaultSyncConfig>} config
 * @param {{ stat?: (p: string) => any, readFile?: (p: string) => Promise<string>, timeoutMs?: number, viaWatcher?: boolean }} [io]
 * @returns {Promise<string>} the verdict applied, for logging and for tests
 */
export async function syncVaultCatalog(config, io) {
  if (!config) return 'skip';
  return passVaultFile(
    config.catalogPath,
    describeVaultCatalogFile,
    (verdict, ctx) =>
      applyCatalogVerdict(config.catalogPath, verdict, { userId: config.userId, sha: ctx.sha, file: ctx.file }),
    io,
  );
}

// ---- the pass ----
/**
 * THE PER-FILE PASS, WRITTEN ONCE (PLAN-017 task 1). Two notes go through it — a daily note and
 * the Catalog — and every step of it is the same for both, for the same reasons: `statSync`
 * classifies for free, a dataless file is recorded and NOT read, a read has a timeout, the
 * whole-file sha takes the cheap exit, and only then is anything parsed.
 *
 * It was one function serving one note before this task. It is a parameterised one now rather
 * than a copy, because the copy is where the two drift: the dataless branch, the timeout and the
 * echo guard are three separate opportunities for the catalog to quietly stop honouring an
 * invariant the daily note still honours, and nothing would fail.
 *
 * WHAT DIFFERS BETWEEN THE TWO IS EXACTLY TWO FUNCTIONS — how the bytes are described to the
 * arbiter (`describe`), and what a verdict does to the index and the store (`apply`). Everything
 * else here is the invariants, and the invariants are not per-note.
 * @param {string} path
 * @param {(text: string) => any} describe
 * @param {(verdict: import('../../shared/types.ts').VaultArbitrationVerdict, ctx: { sha?: string | null, file?: any }) => void} apply
 * @param {{ stat?: (p: string) => any, readFile?: (p: string) => Promise<string>, timeoutMs?: number, viaWatcher?: boolean }} [io]
 * @returns {Promise<string>} the verdict applied, for logging and for tests
 */
async function passVaultFile(path, describe, apply, io) {
  const found = classifyVaultFile(path, io && io.stat);
  // absent → `unknown`, never a deletion. The file may be mid-sync, or on the other machine only.
  if (!found.exists) {
    apply({ verdict: 'unknown' }, {});
    return 'unknown';
  }
  // DATALESS: classify, record, and DO NOT READ. The real-eviction evidence for this branch lives
  // in SB-052 and in task 1's measurements — a temp directory cannot be made dataless, so the test
  // for it injects the stat and asserts that ZERO reads happen.
  if (found.dataless) {
    apply({ verdict: 'unknown' }, {});
    return 'unknown';
  }
  const read = await readVaultNote(path, io);
  if (!read.readable || read.text == null) {
    apply({ verdict: 'unknown' }, {});
    return 'unknown';
  }
  const sha = fileSha(read.text);
  // The echo guard, consulted before anything is parsed. Only from the watcher: a scan is entitled
  // to re-derive the index from the file, and an echo record surviving a settings change should
  // not be able to make a real change invisible.
  if (io && io.viaWatcher) {
    const own = echo.get(path);
    if (own && own.sha === sha) return 'echo';
  }
  const file = describe(read.text);
  const index = db.getVaultIndex(path);
  const verdict = arbitrate({ file, index });
  apply(verdict, { sha, file });
  return verdict.verdict;
}

/**
 * Look at one daily note and do whatever it deserves. The whole engine, for one path.
 * @param {string} path @param {string} date
 * @param {ReturnType<typeof vaultSyncConfig>} config
 * @param {{ stat?: (p: string) => any, readFile?: (p: string) => Promise<string>, timeoutMs?: number, viaWatcher?: boolean }} [io]
 * @returns {Promise<string>} the verdict applied, for logging and for tests
 */
export async function syncVaultPath(path, date, config, io) {
  if (!config) return 'skip';
  return passVaultFile(
    path,
    (text) => describeVaultFile(text, { heading: config.heading, date, projects: config.projects }),
    (verdict, ctx) =>
      applyVerdict(path, date, verdict, {
        userId: config.userId,
        sha: ctx.sha,
        payloadDigest: ctx.file ? ctx.file.payloadDigest : null,
        parse: ctx.file ? ctx.file.parse : undefined,
      }),
    io,
  );
}

/**
 * One pass over every daily note TT is allowed to look at. The boot scan and the interval are the
 * same function; there is no "boot mode".
 * @param {{ stat?: (p: string) => any, readFile?: (p: string) => Promise<string>, timeoutMs?: number }} [io]
 * @returns {Promise<Record<string, number>>} verdict → how many notes got it
 */
export async function scanVault(io) {
  /** @type {Record<string, number>} */
  const counts = {};
  const first = vaultSyncConfig();
  if (!first) return counts;
  // THE CATALOG FIRST, and the order is load-bearing rather than tidy: the note carries the
  // Projects table a daily note's `[[Wikilink]]` cell resolves through (SB-059), so reading it
  // after the days would resolve this pass's cells against the previous pass's catalog.
  //
  // COUNTED UNDER ITS OWN KEY, never folded into the daily verdict counts. `counts.unknown === 3`
  // has meant "three days TT could not read" since SB-057, and quietly making it mean "…or the
  // catalog" would move every existing reading of that number by one without anything failing.
  counts['catalog:' + (await syncVaultCatalog(first, io))] = 1;
  // RE-RESOLVED after the catalog pass, for the same reason the catalog runs first: the import
  // that just landed may have replaced the Projects table this loop resolves cells against.
  const config = vaultSyncConfig();
  if (!config) return counts;
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(config.dailyDir);
  } catch {
    return counts; // the daily folder is not there yet — a first run, or a mistyped path
  }
  for (const name of names.sort()) {
    const m = DAILY_NOTE_RE.exec(name);
    if (!m) continue; // not a daily note; TT reads dates out of filenames and nothing else
    // Pre-cutover days are not TT's to claim — see `afterCutover`. Not even stat-ed: the cheapest
    // possible way to leave 60 of Terje's older notes alone.
    if (!afterCutover(m[1], config.cutoverDay)) continue;
    const verdict = await syncVaultPath(join(config.dailyDir, name), m[1], config, io);
    counts[verdict] = (counts[verdict] || 0) + 1;
  }
  return counts;
}

// ---- the triggers ----
/** @type {import('node:fs').FSWatcher | null} */
let watcher = null;
/** @type {import('node:fs').FSWatcher | null} */
let catalogWatcher = null;
/** @type {any} */
let interval = null;
/** @type {Map<string, any>} */
const debounces = new Map();

/**
 * Start watching, and start the interval. Idempotent — calling it twice does not leak a second
 * watcher, which matters because `tt serve` runs detached for weeks and a handle leaked per
 * settings change is the kind of leak nobody ever sees.
 * @param {{ intervalMs?: number, debounceMs?: number }} [opts]
 * @returns {boolean} whether there was anything to watch
 */
export function startVaultSync(opts) {
  stopVaultSync();
  const config = vaultSyncConfig();
  if (!config) return false;
  // Task 1 measured that a SIGKILL between the write and the rename really does leave a temp
  // behind, and that it stays forever. Once at boot, in the one directory TT writes into.
  sweepVaultTemps(config.dailyDir);
  pruneVaultIndex(config.dailyDir, config.catalogPath);
  const debounceMs = (opts && opts.debounceMs) || WATCH_DEBOUNCE_MS;
  try {
    watcher = watch(config.dailyDir, (_event, filename) => {
      if (!filename) return;
      const name = basename(String(filename));
      const m = DAILY_NOTE_RE.exec(name);
      if (!m) return;
      // Coalesced PER PATH: an editor save is several events, and iCloud lands a file in pieces.
      const existing = debounces.get(name);
      if (existing) clearTimeout(existing);
      debounces.set(
        name,
        setTimeout(() => {
          debounces.delete(name);
          const now = vaultSyncConfig();
          if (!now || !afterCutover(m[1], now.cutoverDay)) return;
          void syncVaultPath(join(now.dailyDir, name), m[1], now, { viaWatcher: true }).catch((err) =>
            console.error('[time-turtle] vault watch failed for', name + ':', /** @type {Error} */ (err).message),
          );
        }, debounceMs),
      );
    });
  } catch (err) {
    // A vault folder that cannot be watched is not a reason to refuse to start: the interval below
    // is a complete second trigger on its own, and saying so is more use than a stack trace.
    console.error(
      `[time-turtle] could not watch ${config.dailyDir} (${/** @type {Error} */ (err).message}) — the interval scan still runs`,
    );
  }
  // THE CATALOG'S OWN WATCHER (PLAN-017 task 1). A second watcher rather than a wider one: the
  // Catalog can sit anywhere `vaultPaths.catalog` points, including the vault ROOT, and watching a
  // folder recursively to catch one file would hand TT an event for every note in the vault.
  //
  // Filtered by basename, because the folder it sits in is not TT's. Same debounce, same reason.
  const catalogDir = dirname(config.catalogPath);
  const catalogName = basename(config.catalogPath);
  try {
    catalogWatcher = watch(catalogDir, (_event, filename) => {
      if (!filename || basename(String(filename)) !== catalogName) return;
      const existing = debounces.get(catalogName);
      if (existing) clearTimeout(existing);
      debounces.set(
        catalogName,
        setTimeout(() => {
          debounces.delete(catalogName);
          const now = vaultSyncConfig();
          if (!now) return;
          void syncVaultCatalog(now, { viaWatcher: true }).catch((err) =>
            console.error('[time-turtle] catalog watch failed:', /** @type {Error} */ (err).message),
          );
        }, debounceMs),
      );
    });
  } catch (err) {
    console.error(
      `[time-turtle] could not watch ${catalogDir} (${/** @type {Error} */ (err).message}) — the interval scan still reads the catalog`,
    );
  }
  interval = setInterval(
    () => {
      void scanVault().catch((err) =>
        console.error('[time-turtle] vault interval scan failed:', /** @type {Error} */ (err).message),
      );
    },
    (opts && opts.intervalMs) || SCAN_INTERVAL_MS,
  );
  // Do not hold the process open on our account: `tt serve` should exit when the server does.
  if (interval.unref) interval.unref();
  return true;
}

/**
 * Drop index rows for paths outside the folder TT is now watching.
 *
 * `vaultPaths.daily` is a SETTING, so re-pointing it leaves rows describing files no scan will ever
 * visit again. A quarantine detected in the abandoned folder would otherwise render on Settings →
 * Vault forever: nothing can clear it, because nothing looks at that path any more. Runs from
 * `startVaultSync`, which is both the boot and the re-point.
 *
 * PATH PREFIX, not date: two folders can hold the same day, which is the case `getVaultIndexByDate`
 * exists for, and the row that survives must be the one under the CURRENT folder.
 *
 * THE CATALOG IS EXEMPT BY PATH (PLAN-017 task 1). It lives outside the daily folder by design —
 * `Time Turtle.md` at the vault root is the live case — so the prefix rule would delete its row on
 * every boot, and with the row goes the standing quarantine on the one note that resolves every
 * rate. Re-pointing `vaultPaths.catalog` drops the OLD catalog row for exactly the reason the rule
 * exists: nothing looks at that path any more.
 * @param {string} dailyDir @param {string} catalogPath
 */
function pruneVaultIndex(dailyDir, catalogPath) {
  const prefix = dailyDir.endsWith('/') ? dailyDir : dailyDir + '/';
  for (const row of db.listVaultIndex()) {
    if (row.path === catalogPath) continue;
    if (row.path.startsWith(prefix)) continue;
    db.deleteVaultIndex(row.path);
    console.log(`[time-turtle] vault index: dropped ${row.path} — outside the current daily folder`);
  }
}

/** Tear both triggers down, and every pending debounce with them. */
export function stopVaultSync() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (catalogWatcher) {
    catalogWatcher.close();
    catalogWatcher = null;
  }
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  for (const timer of debounces.values()) clearTimeout(timer);
  debounces.clear();
}

/**
 * The synchronous read of one note's bytes, for the writer — which needs the file it is about to
 * splice into and must not race the async path. Absent reads as an empty string, which is what
 * DD-012 adoption of a brand-new day needs; unreadable rethrows, because a writer that cannot read
 * the note it is about to replace must not write it.
 * @param {string} path @returns {string | null} null when the file is not there
 */
export function readNoteForWrite(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return null;
    throw err;
  }
}
