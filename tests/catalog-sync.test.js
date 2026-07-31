// PLAN-017 tasks 1–2 — the CATALOG note wired to the sync engine, against a real temp vault.
//
// Before this, `Time Turtle.md` had never been opened: `parseVaultCatalog` / `writeVaultCatalog`
// were PLAN-011's codec with their own tests and no production caller at all. The vault said
// `TUR`, `INT` and `LIFE` and nothing in it said what those codes meant.
//
// WHAT A GREEN RUN HERE DOES NOT PROVE:
//   • that the note reaches a RUNNING app's `/api/state`. That is the api rung, and it is the
//     verification stanza's second half — a module test cannot see the wire.
//   • that iCloud lands a catalog written on the other machine in a way macOS fires an event for.
//     Same gap the daily notes have, same reason the slow interval exists.
//
// What it DOES prove: a hand-written note is read through the real filesystem, an unchanged one is
// skipped, an external edit imports, a missing section reads as zero rows, a note with none of the
// four headings is refused and surfaced rather than treated as empty, and a read that fails leaves
// every row TT already holds exactly where it is.
//
// ## Verified red-green: 2026-07-31
// Task 1, two breaks, each reddening exactly the assertion it should and nothing else:
//   • dropped the zero-of-four refusal in `TT.parseVaultCatalog` so four absences fell through as
//     an empty catalog → "zero of the four headings is refused and surfaced" failed, 11 others green.
//   • replaced `TT.vaultCatalogSettings` with `Object.fromEntries(rows)` in `importCatalog` →
//     "the note cannot reach the three settings that say where the note IS" failed, 11 others green.
//
// Task 2, three breaks, and the third is recorded because it did NOT redden anything:
//   • dropped the payload-digest comparison in `writeVaultCatalogNote` → "a write that moves no
//     payload is SKIPPED" failed alone, 22 others green.
//   • made `store.putSettings` always pass `mayCreate: true` → "a settings write that carries
//     nothing the note owns does NOT create it" failed alone, 22 others green.
//   • made `TT.writeVaultCatalog` backfill on ANY locate refusal rather than only `no-heading` →
//     STAYED GREEN. Not a gap in the tests: the whole-note parse at the top of that function has
//     already refused a heading that is present and unreadable, so the branch is unreachable by
//     construction. Said out loud at the line rather than left looking like an untested gate.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { containsRow } from './util.js';

/** @type {typeof import('../server/src/vault-sync.js')} */
let sync;
/** @type {typeof import('../server/src/db.js')} */
let db;
/** @type {typeof import('../server/src/store.js')} */
let store;

let vaultRoot = '';
let catalogPath = '';
let userId = 0;

const FJELLHEIM = { id: 'fjellheim', name: 'Fjellheim AS', rate: 1150, rounding: 15, archived: false };
const BRYGGA = { id: 'brygga', name: 'Brygga Digital', rate: 900, rounding: 'exact', archived: false };
const TUR = { code: 'TUR', name: 'Turbinhall', clientId: 'fjellheim', rate: null, billable: true, archived: false };
const INT = { code: 'INT', name: 'Internal', clientId: null, rate: null, billable: false, archived: false };
const TEMPLATE = { id: 'standup', label: 'Standup', project: 'INT' };

const CATALOG = {
  clients: [FJELLHEIM, BRYGGA],
  projects: [TUR, INT],
  tasks: [TEMPLATE],
  settings: [
    { key: 'currency', value: 'NOK' },
    { key: 'language', value: 'nb' },
    { key: 'vaultTimeSeparator', value: 'ascii' },
    // DD-026 clause 5 put the heading in the note (PLAN-017 task 3). A fixture without it is a
    // note whose Settings section TT would canonically ADD a row to, which is a payload move — so
    // leaving it out would make the DD-020 c7 skip case test the wrong thing.
    { key: 'timeLogHeading', value: 'Time Log' },
  ],
};

/** The bytes of a whole catalog note, with Terje's own prose around the four sections. */
const note = (catalog = CATALOG, revision = 3) =>
  '# Time Turtle\n\nthe rates live here\n\n' + TT.serializeVaultCatalog(catalog, { revision }).split('\n').slice(2).join('\n'); // prettier-ignore

beforeAll(async () => {
  process.env.TT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tt-catalog-sync-data-'));
  process.env.TT_SHAPE = 'personal'; // config.js reads this at import; the backend derives from it
  db = await import('../server/src/db.js');
  sync = await import('../server/src/vault-sync.js');
  // The real seam, so the write fan-out is exercised through the code the API layer calls rather
  // than through a hand-built imitation of it.
  store = await import('../server/src/store.js');
  const user = db.createUser({ email: 'solo@timeturtle.local', name: 'Solo', role: 'admin', password: 'pw' });
  userId = user.id;
});

beforeEach(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'tt-catalog-sync-'));
  mkdirSync(join(vaultRoot, 'Calendar', 'Daily'), { recursive: true });
  // The LIVE shape of Terje's own install: the note at the vault root, not under a folder.
  db.putSettings({
    shape: 'personal',
    vaultPaths: { root: vaultRoot, daily: 'Calendar/Daily', catalog: 'Time Turtle.md' },
  });
  catalogPath = join(vaultRoot, 'Time Turtle.md');
  for (const row of db.listVaultIndex()) db.deleteVaultIndex(row.path);
  db.putClients([]);
  db.putProjects([]);
  db.putTasks(userId, []);
  db.putSettings({ currency: 'kr', language: 'en', vaultTimeSeparator: 'unicode' });
  sync.forgetOwnWrites();
  sync.setVaultCatalogRewriter(null);
});
afterEach(() => {
  sync.stopVaultSync();
  rmSync(vaultRoot, { recursive: true, force: true });
});

/** The one call under test, resolved through the real config the way the interval does. */
const pass = (io) => sync.syncVaultCatalog(sync.vaultSyncConfig(), io);

describe('the catalog note, read', () => {
  it('a hand-written note is read: clients, projects, templates and settings reach the store', async () => {
    writeFileSync(catalogPath, note());
    const before = db.getVersions(userId).catalog;

    expect(await pass()).toBe('import');

    expect(db.getClients().map((client) => client.id).sort()).toEqual(['brygga', 'fjellheim']); // prettier-ignore
    expect(db.getClients().find((client) => client.id === 'fjellheim').rate).toBe(1150);
    expect(db.getProjects().map((project) => project.code).sort()).toEqual(['INT', 'TUR']); // prettier-ignore
    expect(db.getProjects().find((project) => project.code === 'TUR').clientId).toBe('fjellheim');
    expect(db.getTasks(userId)).toEqual([TEMPLATE]);
    const settings = db.getSettings();
    expect(settings.currency).toBe('NOK');
    expect(settings.language).toBe('nb');
    expect(settings.vaultTimeSeparator).toBe('ascii');
    // DC-001: without the bump an open tab PUTs its stale catalog straight back over the import.
    expect(db.getVersions(userId).catalog).toBeGreaterThan(before);

    const row = db.getVaultIndex(catalogPath);
    expect(row.state).toBe('known');
    expect(row.rev).toBe(3);
    expect(row.verified).toBe(true);
    expect(row.date).toBe(''); // the Catalog is state that is NOT a day (TERM-004)
  });

  it('the note cannot reach the three settings that say where the note IS', async () => {
    // The bootstrap loop `TT.vaultCatalogSettings`' allowlist exists to prevent: a note that could
    // set `vaultPaths` could point TT at a different note, and a note that could set `shape` could
    // turn the vault off. Carried verbatim on the rows, applied never.
    const meddling = {
      ...CATALOG,
      settings: [
        ...CATALOG.settings,
        { key: 'shape', value: 'team' },
        { key: 'mdDir', value: '/tmp/somewhere-else' },
        { key: 'vaultPaths', value: '{"root":"/tmp/elsewhere"}' },
      ],
    };
    writeFileSync(catalogPath, note(meddling));
    expect(await pass()).toBe('import');
    const settings = db.getSettings();
    expect(settings.shape).toBe('personal');
    expect(settings.mdDir).toBe('');
    expect(settings.vaultPaths.root).toBe(vaultRoot);
  });

  it('an unchanged file is skipped — the second pass imports nothing', async () => {
    writeFileSync(catalogPath, note());
    await pass();
    const version = db.getVersions(userId).catalog;
    expect(await pass()).toBe('skip');
    expect(db.getVersions(userId).catalog).toBe(version);
  });

  it('a rate edited outside TT is picked up by the next pass', async () => {
    writeFileSync(catalogPath, note());
    await pass();
    // The other machine wrote it — a real revision bump, which is the shared-vault case.
    writeFileSync(catalogPath, note({ ...CATALOG, clients: [{ ...FJELLHEIM, rate: 1400 }, BRYGGA] }, 4));
    expect(await pass()).toBe('import');
    expect(db.getClients().find((client) => client.id === 'fjellheim').rate).toBe(1400);
    expect(db.getVaultIndex(catalogPath).rev).toBe(4);
  });

  it('a section that is not there reads as zero rows — DD-020 c1, subset-tolerant', async () => {
    // Without this, the day TT gains a fifth section every catalog already in a vault quarantines
    // on upgrade, with the recovery being a hand edit to the money file.
    const withoutTemplates = note()
      .replace(TT.serializeVaultCatalogSection('tasks', CATALOG.tasks, { revision: 3 }) + '\n\n', '');
    expect(withoutTemplates).not.toContain('## Task templates');
    writeFileSync(catalogPath, withoutTemplates);

    expect(await pass()).toBe('import');
    expect(db.getVaultIndex(catalogPath).state).toBe('known');
    expect(db.getTasks(userId)).toEqual([]);
    expect(db.getClients()).toHaveLength(2); // the sections that ARE there still land
  });

  it('a heading present with no revision line still quarantines — backfill is not adoption', async () => {
    // DD-020 c2's exact boundary. Absent → tolerated. Present and unanchored → refused, because
    // DD-012 adoption is deliberately off for this note.
    const unanchored = ['# Time Turtle', '', '## Clients', '', '| Client | Name |', '|---|---|', '| brygga | Brygga Digital |', ''].join('\n'); // prettier-ignore
    writeFileSync(catalogPath, unanchored);

    expect(await pass()).toBe('quarantine');
    const row = db.getVaultIndex(catalogPath);
    expect(row.state).toBe('quarantined');
    expect(row.quarantineReason).toBe('no-revision');
    expect(row.quarantineSection).toBe('clients');
    expect(db.getClients()).toEqual([]);
  });

  it('zero of the four headings is refused and surfaced, never treated as an empty catalog', async () => {
    // The guard against a mistyped `vaultPaths.catalog` landing on an innocent note. Tolerating
    // four absences at once would report somebody's shopping list as an empty catalog — and the
    // first write would then put four tables into it.
    db.putClients([FJELLHEIM]);
    writeFileSync(catalogPath, '# Groceries\n\n- milk\n- coffee\n');

    expect(await pass()).toBe('quarantine');
    const row = db.getVaultIndex(catalogPath);
    expect(row.state).toBe('quarantined');
    expect(row.quarantineReason).toBe('no-heading');
    expect(row.quarantineSection).toBe(null); // a fact about the note, not about one section
    expect(db.getClients()).toHaveLength(1); // nothing was emptied
  });

  it('a read that fails is `unknown`, and deletes nothing', async () => {
    writeFileSync(catalogPath, note());
    await pass();
    expect(db.getClients()).toHaveLength(2);

    const verdict = await pass({ readFile: () => Promise.reject(new Error('EACCES')) });
    expect(verdict).toBe('unknown');
    expect(db.getVaultIndex(catalogPath).state).toBe('unknown');
    // Invariant 1 on the write side: a file TT could not read is one it knows nothing NEW about.
    expect(db.getClients()).toHaveLength(2);
    expect(db.getVaultIndex(catalogPath).rev).toBe(3);
  });

  it('an absent note is `unknown` and empties nothing', async () => {
    db.putClients([FJELLHEIM]);
    expect(await pass()).toBe('unknown');
    expect(db.getClients()).toHaveLength(1);
  });

  it('a dataless (iCloud-evicted) note is recorded without being read at all', async () => {
    writeFileSync(catalogPath, note());
    let reads = 0;
    const verdict = await pass({
      stat: () => ({ size: 4096, blocks: 0 }),
      readFile: () => ((reads += 1), Promise.resolve('')),
    });
    expect(verdict).toBe('unknown');
    expect(reads).toBe(0);
  });

  it('the interval scan reads the catalog, under its own count', async () => {
    // Counted separately, never folded into the daily verdict counts: `counts.unknown === 3` has
    // meant "three DAYS TT could not read" since SB-057.
    writeFileSync(catalogPath, note());
    const counts = await sync.scanVault();
    expect(counts['catalog:import']).toBe(1);
    expect(counts.import).toBe(undefined);
    expect(db.getClients()).toHaveLength(2);
  });

  it('the catalog index row survives a boot — the prune does not reach outside the daily folder', async () => {
    writeFileSync(catalogPath, note());
    await pass();
    expect(db.getVaultIndex(catalogPath)).not.toBe(null);
    // `startVaultSync` prunes every row outside the CURRENT daily folder. The catalog lives
    // outside it by design, and a pruned row takes a standing quarantine with it.
    sync.startVaultSync({ intervalMs: 3_600_000 });
    expect(db.getVaultIndex(catalogPath)).not.toBe(null);
    expect(db.getVaultIndex(catalogPath).rev).toBe(3);
  });
});

describe('the catalog note, written', () => {
  /** The bytes on disk right now. */
  const onDisk = () => readFileSync(catalogPath, 'utf8');

  it('a client added in the app reaches the note, all four sections at N+1', async () => {
    writeFileSync(catalogPath, note());
    await pass(); // TT now knows this note — the `unread` gate needs a confirmed read

    store.putClients([FJELLHEIM, BRYGGA, { id: 'nyk', name: 'Ny Kunde', rate: 700, rounding: 'exact', archived: false }]); // prettier-ignore

    const after = onDisk();
    expect(containsRow(after, '| nyk | Ny Kunde | 700 | exact |')).toBe(true);
    // ONE COUNTER, FOUR SECTIONS, all bumped together (DD-020 c4). A section left behind would
    // quarantine the note as `catalog-revision-mismatch` on its own next read.
    const revisions = [...after.matchAll(/`revision: (\d+) · /g)].map((m) => +m[1]);
    expect(revisions).toEqual([4, 4, 4, 4]);
    expect(TT.parseVaultCatalog(after).quarantine).toBe(false);
  });

  it("every byte outside the four regions is left alone — above, between and below", async () => {
    const withProse = note().replace('## Projects', 'a paragraph Terje wrote between two sections\n\n## Projects') + '\nand a closing line of his\n'; // prettier-ignore
    writeFileSync(catalogPath, withProse);
    await pass();
    const before = onDisk();

    store.putClients([FJELLHEIM]);

    const after = onDisk();
    expect(after).toContain('the rates live here');
    expect(after).toContain('a paragraph Terje wrote between two sections');
    expect(after).toContain('and a closing line of his');
    // and the only lines that moved are inside the four regions — a golden alone cannot see that
    // TT ate the paragraph above `## Clients`, so the diff is taken line by line
    const moved = diffLines(before, after);
    expect(moved.every((line) => line.startsWith('|') || line.startsWith('`revision:'))).toBe(true);
  });

  it('a section the note lacks is BACKFILLED, at the same N as the rest', async () => {
    const withoutTemplates = note().replace(TT.serializeVaultCatalogSection('tasks', CATALOG.tasks, { revision: 3 }) + '\n\n', ''); // prettier-ignore
    writeFileSync(catalogPath, withoutTemplates);
    await pass();
    expect(db.getTasks(userId)).toEqual([]);

    store.putTasks(userId, [TEMPLATE]);

    const after = onDisk();
    expect(after).toContain('## Task templates');
    expect(containsRow(after, '| standup | Standup | INT |')).toBe(true);
    const revisions = [...after.matchAll(/`revision: (\d+) · /g)].map((m) => +m[1]);
    expect(revisions).toEqual([4, 4, 4, 4]);
    expect(TT.parseVaultCatalog(after).quarantine).toBe(false);
  });

  it('a heading present with no revision line still refuses — backfill is not adoption', async () => {
    const unanchored = ['# Time Turtle', '', '## Clients', '', '| Client | Name |', '|---|---|', '| brygga | Brygga Digital |', ''].join('\n'); // prettier-ignore
    writeFileSync(catalogPath, unanchored);
    await pass(); // quarantines

    store.putClients([FJELLHEIM]);

    expect(onDisk()).toBe(unanchored); // not one byte
  });

  it('an absent note is CREATED by the first write that needs it', async () => {
    expect(existsSync(catalogPath)).toBe(false);

    store.putClients([FJELLHEIM, BRYGGA]);

    expect(existsSync(catalogPath)).toBe(true);
    const created = TT.parseVaultCatalog(onDisk());
    expect(created.quarantine).toBe(false);
    expect(created.revision).toBe(1); // a first write starts at 1
    expect(created.clients.map((client) => client.id).sort()).toEqual(['brygga', 'fjellheim']); // prettier-ignore
  });

  it('a settings write that carries nothing the note owns does NOT create it', async () => {
    // DD-020 c8: creation is lazy and never a boot side-effect. SB-100's boot-time inference is
    // exactly `putSettings({ shape })`, run because the process started.
    expect(existsSync(catalogPath)).toBe(false);
    store.putSettings({ shape: 'personal' });
    expect(existsSync(catalogPath)).toBe(false);
    // …and a setting the note DOES own creates it, so the gate is about the key and not about
    // settings writes in general
    store.putSettings({ currency: 'NOK' });
    expect(existsSync(catalogPath)).toBe(true);
    // ON CELL CONTENT, never on framing (DD-023's fixture rule): the column widths come out of
    // whatever the widest row happens to be, and a padded literal silently stops matching.
    expect(containsRow(onDisk(), '| currency | NOK |')).toBe(true);
  });

  it('a file at the path with zero of the four headings is refused, never created over', async () => {
    const stranger = '# Groceries\n\n- milk\n- coffee\n';
    writeFileSync(catalogPath, stranger);
    await pass();

    store.putClients([FJELLHEIM]);

    expect(onDisk()).toBe(stranger);
    expect(db.getVaultIndex(catalogPath).state).toBe('quarantined');
  });

  it('a write that moves no payload is SKIPPED — DD-020 c7, the money file is not rewritten', async () => {
    writeFileSync(catalogPath, note());
    await pass();
    // Terje types a sentence BETWEEN two sections. The file's sha moves; no payload does.
    const edited = onDisk().replace('## Projects', 'a thought\n\n## Projects');
    writeFileSync(catalogPath, edited);
    await pass();

    store.putClients([FJELLHEIM, BRYGGA]); // the same clients already in the note

    expect(onDisk()).toBe(edited); // not rewritten, and no counter moved
    expect([...onDisk().matchAll(/`revision: (\d+) · /g)].map((m) => +m[1])).toEqual([3, 3, 3, 3]);
  });

  it('a note that broke on disk SINCE the last scan is refused, not written over', async () => {
    // The race the `writeEligibility` gate cannot see: the index says `known` because the scan read
    // a good note, and a human has damaged it since. The write re-parses rather than trusting the
    // row, because trusting it means splicing four tables over bytes TT has never read.
    writeFileSync(catalogPath, note());
    await pass();
    expect(db.getVaultIndex(catalogPath).state).toBe('known');
    // A rate changed by hand, leaving the section's fingerprint describing the old bytes. The
    // structurally-valid, semantically-wrong note DD-009 exists to catch, on the money file.
    const damaged = onDisk().replace('1150', '9999');
    writeFileSync(catalogPath, damaged);

    store.putClients([FJELLHEIM]);

    expect(onDisk()).toBe(damaged); // not one byte
    const row = db.getVaultIndex(catalogPath);
    expect(row.state).toBe('quarantined');
    expect(row.quarantineReason).toBe('digest-mismatch');
    expect(row.quarantineSection).toBe('clients');
  });

  it("TT's own write does not come back through the watcher as an import", async () => {
    writeFileSync(catalogPath, note());
    await pass();
    store.putClients([FJELLHEIM]);
    const version = db.getVersions(userId).catalog;
    // The watcher's pass, with the echo record in place.
    expect(await pass({ viaWatcher: true })).toBe('echo');
    expect(db.getVersions(userId).catalog).toBe(version);
  });

  it('the note TT writes is one TT reads back with no change at all', async () => {
    store.putClients([FJELLHEIM, BRYGGA]);
    store.putProjects([TUR, INT]);
    const written = onDisk();
    // The round-trip that pins the format: a scan straight after a write takes the cheap exit,
    // rather than re-importing bytes TT just emitted.
    expect(await pass()).toBe('skip');
    expect(onDisk()).toBe(written);
  });
});

/** The lines that differ between two notes, in either direction. */
function diffLines(before, after) {
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  return [...before.split('\n').filter((line) => !b.has(line)), ...after.split('\n').filter((line) => !a.has(line))];
}
