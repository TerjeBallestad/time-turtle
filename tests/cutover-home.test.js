// PLAN-017 task 3 — DD-026 clause 5's table, built. Two facts, two homes.
//
// THE CUTOVER (TERM-020) is the day from which THIS VAULT holds TT history. It lives in the
// Catalog's Settings section, as `cutover`, as a `YYYY-MM-DD` day and nothing else.
//
// THE SHAPE STAMP (TERM-021) is the instant THIS INSTALL stored its shape. It stays in SQLite,
// under a name that says so, and after task 4 no rule that decides whether a day is writable may
// read it. Leaving the old name on a value that is no longer the Cutover is the two-meanings-one-
// word fault DD-026 exists to remove, which is why the rename is not optional and not aliased.
//
// `timeLogHeading` MOVES OUT of `vaultPaths` and into the Catalog, by clause 5's own test: two
// machines disagreeing about it would put two blocks in one note, so it is vault property.
//
// WHAT THIS FILE DOES NOT PROVE: that a frozen day became typeable. At the end of task 3
// `TT.preCutover` still reads the renamed SQLite row — a deliberate intermediate inside one serial
// run, so that each commit builds. Task 4 flips the rules and has its own evidence.
//
// ## Verified red-green: 2026-07-31
//   • made the `cutover` validator accept anything (`() => true`) → "an ISO instant is refused"
//     failed alone.
//   • made `parseVaultPaths` keep reconstructing `timeLogHeading` → "the heading is not in
//     vaultPaths any more" failed alone.
//   • dropped the `vaultCutover` → `shapeStamp` row migration → "an install that stored the old
//     name reads it under the new one" failed alone.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';

/** @type {typeof import('../server/src/db.js')} */
let db;
let dataDir = '';

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tt-cutover-home-'));
  process.env.TT_DATA_DIR = dataDir;
  process.env.TT_SHAPE = 'personal';
  db = await import('../server/src/db.js');
  db.createUser({ email: 'solo@timeturtle.local', name: 'Solo', role: 'admin', password: 'pw' });
});

describe('the Catalog carries the Cutover and the heading', () => {
  it('both keys round-trip through the note', () => {
    const rows = [
      { key: 'cutover', value: '2026-07-27' },
      { key: 'timeLogHeading', value: 'Tidslogg' },
    ];
    const note = TT.serializeVaultCatalog({ settings: rows }, { revision: 1 });
    const parsed = TT.parseVaultCatalog(note);
    expect(parsed.quarantine).toBe(false);
    expect(TT.vaultCatalogSettings(parsed.settings)).toEqual({ cutover: '2026-07-27', timeLogHeading: 'Tidslogg' }); // prettier-ignore
  });

  it('a `cutover` that is an ISO instant is REFUSED — clause 6, a DAY and never an instant', () => {
    // The precision was never read (`preCutover` sliced it to ten characters) and SB-147 is the
    // bug that precision caused: a UTC instant compared against a local day. Dissolved by refusing
    // to store one at all.
    for (const bad of ['2026-07-27T12:48:47.681Z', '2026-07-27T00:00', '27.07.2026', '2026-7-27', '', 'today'])
      expect(TT.vaultCatalogSettings([{ key: 'cutover', value: bad }])).toEqual({});
    expect(TT.vaultCatalogSettings([{ key: 'cutover', value: '2026-07-27' }])).toEqual({ cutover: '2026-07-27' }); // prettier-ignore
  });

  it('an empty `timeLogHeading` is refused — a blank heading matches every note and none', () => {
    expect(TT.vaultCatalogSettings([{ key: 'timeLogHeading', value: '' }])).toEqual({});
    expect(TT.vaultCatalogSettings([{ key: 'timeLogHeading', value: '   ' }])).toEqual({});
    expect(TT.vaultCatalogSettings([{ key: 'timeLogHeading', value: 'Time Log' }])).toEqual({ timeLogHeading: 'Time Log' }); // prettier-ignore
  });

  it('the three settings that say where the note IS are still excluded', () => {
    // The allowlist is what keeps the bootstrap loop closed, and adding two keys to it must not
    // widen it by accident. Asserted on both spellings of the renamed axis, so it cannot go
    // quietly green.
    for (const key of ['shape', 'backend', 'vaultPaths', 'mdDir', 'vaultCutover', 'shapeStamp'])
      expect(TT.VAULT_CATALOG_SETTING_KEYS).not.toContain(key);
    expect(TT.VAULT_CATALOG_SETTING_KEYS).toEqual(
      expect.arrayContaining(['currency', 'language', 'vaultTimeSeparator', 'cutover', 'timeLogHeading']),
    );
  });
});

describe('the heading leaves vaultPaths', () => {
  it('`TT.VAULT_PATHS_DEFAULT` no longer carries it', () => {
    expect(TT.VAULT_PATHS_DEFAULT).not.toHaveProperty('timeLogHeading');
    expect(Object.keys(TT.VAULT_PATHS_DEFAULT).sort()).toEqual(['catalog', 'daily', 'root', 'weekly']);
  });

  it('a heading pushed through `vaultPaths` is dropped, not stored', () => {
    // `putSettings` validates `vaultPaths` by RECONSTRUCTION from the default, so a key that is
    // not on the default cannot reach the row. That is the mechanism, and this is the assertion
    // that it still holds once the key is gone.
    db.putSettings({ vaultPaths: { root: '/tmp/x', timeLogHeading: 'Sneaked In' } });
    expect(db.getSettings().vaultPaths).not.toHaveProperty('timeLogHeading');
  });

  it('an install with no Catalog and no stored heading takes `Time Log`', () => {
    expect(db.getSettings().timeLogHeading).toBe('Time Log');
  });

  it('a heading stored in the OLD vaultPaths JSON is migrated onto its own row', () => {
    // The upgrade path. Terje's install has one; a migration that orphaned it would silently move
    // his block to a heading he never chose, in every daily note he owns.
    db.db.exec(
      "INSERT INTO settings (key, value) VALUES ('vaultPaths', '{\"root\":\"/tmp/v\",\"daily\":\"Calendar/Daily\",\"timeLogHeading\":\"Tidslogg\"}') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    db.db.exec("DELETE FROM settings WHERE key = 'timeLogHeading'");
    db.migrateVaultSettingHomes();
    expect(db.getSettings().timeLogHeading).toBe('Tidslogg');
    expect(db.getSettings().vaultPaths).not.toHaveProperty('timeLogHeading');
    // idempotent — a second boot must not resurrect or clobber it
    db.putSettings({ timeLogHeading: 'Time Log' });
    db.migrateVaultSettingHomes();
    expect(db.getSettings().timeLogHeading).toBe('Time Log');
  });
});

describe('the SQLite row becomes the Shape stamp', () => {
  it('the old spelling survives ONLY inside the one-shot migration', async () => {
    // The check that can actually fail. A leftover reader of `vaultCutover` typechecks perfectly
    // if the key is still on the object, and a green suite says nothing about it.
    //
    // `-w` (whole word), so a NAME that merely contains the old spelling is not a reader of it —
    // `resolvedVaultCutover` was called `vaultCutoverInForce` for exactly one commit and that is
    // how this test caught it. The retired thing is the settings KEY.
    //
    // NOT "the string appears nowhere", which is what the plan's stanza asked for and which is
    // unsatisfiable: a migration that moves the row has to name the row it is moving, and the
    // alternative — orphaning Terje's stamp — is the thing the migration exists to prevent. The
    // honest claim is the one made here: exactly one file may say the word, and it is the file
    // that deletes it.
    const { execFileSync } = await import('node:child_process');
    /** @param {string[]} paths */
    const filesSaying = (paths) => {
      try {
        return execFileSync('git', ['grep', '-l', '-w', '--', 'vaultCutover', ...paths], {
          cwd: new URL('..', import.meta.url).pathname,
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .filter(Boolean);
      } catch {
        return []; // `git grep` exits 1 with no output when nothing matches
      }
    };
    expect(filesSaying(['shared', 'client/src', 'tests-browser'])).toEqual([]);
    expect(filesSaying(['server/src'])).toEqual(['server/src/db.js']);
    // and inside that file it is confined to the migration — no accessor, no default, no reader
    const { readFileSync } = await import('node:fs');
    const dbSource = readFileSync(new URL('../server/src/db.js', import.meta.url), 'utf8');
    const migration = dbSource.slice(
      dbSource.indexOf('DD-026 clause 5 / PLAN-017 task 3'),
      dbSource.indexOf('migrateVaultSettingHomes();'),
    );
    const total = dbSource.split('vaultCutover').length - 1;
    const inMigration = migration.split('vaultCutover').length - 1;
    expect(inMigration).toBe(total);
  });

  it('an install that stored the old name reads it under the new one', () => {
    const stamped = '2026-07-28T12:48:47.681Z';
    db.db.exec("DELETE FROM settings WHERE key IN ('shapeStamp', 'vaultCutover')");
    db.db.exec(`INSERT INTO settings (key, value) VALUES ('vaultCutover', '${stamped}')`);
    db.migrateVaultSettingHomes();
    expect(db.getSettings().shapeStamp).toBe(stamped);
    const raw = db.db.prepare("SELECT value FROM settings WHERE key = 'vaultCutover'").get();
    expect(raw).toBe(undefined); // migrated, not duplicated
  });

  it('the stamp is still first-stamp-wins', () => {
    db.db.exec("DELETE FROM settings WHERE key = 'shapeStamp'");
    const first = db.stampShape();
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(db.stampShape()).toBe(first);
    // and a round trip through `team` and back must not re-stamp: a later date silently re-opens
    // history that was already excluded
    db.putSettings({ shape: 'team' });
    db.putSettings({ shape: 'personal' });
    expect(db.getSettings().shapeStamp).toBe(first);
  });

  it('the stamp is server-owned — a client cannot move it through putSettings', () => {
    const held = db.getSettings().shapeStamp;
    db.putSettings(/** @type {any} */ ({ shapeStamp: '2000-01-01T00:00:00.000Z' }));
    expect(db.getSettings().shapeStamp).toBe(held);
  });
});
