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
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';

/** @type {typeof import('../server/src/vault-sync.js')} */
let sync;
/** @type {typeof import('../server/src/db.js')} */
let db;

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
