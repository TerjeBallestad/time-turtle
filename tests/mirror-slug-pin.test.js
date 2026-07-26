// SB-112: the mirror filename is PINNED at user creation, so a rename cannot fork it.
//
// `mirrorPath` used to slug `users.name` on every write, making the filename a function of a
// mutable field: rename the user and the next save writes a NEW file and silently abandons the
// old one, which stays in the vault looking like a current timesheet. `users.mirror_slug` is now
// settled once and never recomputed.
//
// WHAT THE LIVE DATA ACTUALLY SAID, because this ticket asked and SB-088's executor could only
// guess from filenames: the live `users` table holds Admin(1), Kari Ansatt(2), Terje(3),
// Terje 2(4), Review Demo(7). `timesheet-terje.md` and `timesheet-terje-2.md` are therefore the
// CURRENT mirrors of two different people, not the orphan pair SB-112's body reports. Zero
// orphans on disk, and no `UPDATE users SET name` exists anywhere in the server — there is no
// rename route at all, so the fork was unreachable rather than merely unrealised. This file
// reaches it the only way it can be reached today: by writing the name straight into sqlite.
//
// THE RENAME IS DRIVEN THROUGH SQLITE ON PURPOSE, and that is not a cheat — it is the only
// writer of `users.name` that exists after `createUser`, so it is exactly the event the fix has
// to survive. When a rename route lands it will go through the same column.
//
// ## Verified red-green: 2026-07-26 (output TRANSCRIBED from the runs, not reconstructed)
//
//   Mutation 1 — un-pin `mirrorPath` (server/src/markdown.js), i.e. restore the pre-SB-112 body
//   `const slug = TT.slug(user.name || user.email.split('@')[0]);`:
//     FAIL  a rename does not fork the mirror — the file keeps its name and its hours
//           AssertionError: expected [ 'timesheet-admin.md', …(1) ] to deeply equal [ 'timesheet-admin.md' ]
//     the second element being `timesheet-renamed-person.md` — the orphan this ticket is about.
//     The other two tests pass under it, correctly: neither claims the pin.
//
//   Mutation 2 — make the backfill derive from something other than the current name
//   (server/src/db.js, `pin.run(deriveMirrorSlug(row), row.id)` → `pin.run('user-' + row.id, row.id)`):
//     FAIL  the backfill pins an existing user to the file already on disk, and moves nothing
//           AssertionError: expected [ 'timesheet-admin.md', …(1) ] to deeply equal [ 'timesheet-admin.md' ]
//     FAIL  an abandoned path stays a guard-ledger key, so retireMirrors still sweeps it
//           AssertionError: expected [ 'timesheet-admin.md', …(1) ] to deeply equal [ 'timesheet-admin.md', …(1) ]
//     i.e. a backfill that does not reproduce the old derivation orphans every existing mirror
//     on the first save after upgrade — the exact harm the fix is supposed to prevent (the file
//     that appears is `timesheet-user-1.md`). Test 1 PASSES under it, correctly: it never clears
//     `mirror_slug`, so `createUser` pins the row and the backfill never sees it.
//
//   Mutation 3 — `retireMirrors()` (server/src/markdown.js) `return []` immediately:
//     FAIL  an abandoned path stays a guard-ledger key, so retireMirrors still sweeps it
//           AssertionError: expected [ 'timesheet-admin.md', …(1) ] to deeply equal [ …(2) ]
//     which is the requirement the pin must not cost: old paths stay ledger keys. Tests 1 and 2
//     pass under it — neither claims anything about sweeping.
import { describe, it, expect, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer, stopAllServers, adminOn } from './util.js';

afterAll(stopAllServers);

const TODAY = new Date().toISOString().slice(0, 10);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, md: join(data, 'mirror') };
}

/** Every .md in the mirror dir, sorted. */
function mdFiles(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : [];
}

/** The guard ledger's file keys, sorted. This is the set `retireMirrors` sweeps. */
function ledgerKeys(data) {
  const path = join(data, 'mirror-guard.json');
  if (!existsSync(path)) return [];
  return Object.keys(JSON.parse(readFileSync(path, 'utf8')).files ?? {}).sort();
}

/**
 * Edit the users table the way nothing in the app can. The server is always stopped first —
 * two writers on one WAL is a different test than the one being run here.
 */
function withDb(data, fn) {
  const db = new DatabaseSync(join(data, 'timeturtle.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Log an hour so the mirror is really written, and prove the DB took it. */
async function logAnHour(admin, id) {
  const state = await admin('GET', '/api/state');
  const entry = { id, date: '2026-07-26', start: 540, end: 600, project: null, label: id, note: '', billable: 1 };
  const put = await admin('PUT', '/api/state', { entries: [...state.json.entries, entry] });
  expect(put.status).toBe(200);
  const after = await admin('GET', '/api/state');
  expect(after.json.entries.some((e) => e.id === id)).toBe(true);
  return put;
}

describe('SB-112: the mirror filename survives a rename', () => {
  it('a rename does not fork the mirror — the file keeps its name and its hours', async () => {
    const { data, md } = dataDir('slug-rename');
    let server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(server.port);
    const first = await logAnHour(admin, 'e1-before-rename');
    expect(mdFiles(md)).toEqual(['timesheet-admin.md']);
    const canonical = first.json.mirror;
    await stopServer(server.child);

    // The rename. `mirror_slug` is left alone — that is the whole point: the pin is not a
    // function of the name any more, so the name may move and the file may not.
    withDb(data, (db) => db.prepare("UPDATE users SET name = 'Renamed Person' WHERE id = 1").run());

    server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    admin = await adminOn(server.port);
    expect((await admin('GET', '/api/state')).status).toBe(200);
    const second = await logAnHour(admin, 'e2-after-rename');

    // ONE file, the same one. Asserting only that the new hour landed somewhere would pass
    // against the fork — the hours are complete in the NEW file there too. The claim is that
    // there is no new file.
    expect(mdFiles(md)).toEqual(['timesheet-admin.md']);
    expect(second.json.mirror).toBe(canonical);
    const text = readFileSync(canonical, 'utf8');
    expect(text).toContain('e1-before-rename');
    expect(text).toContain('e2-after-rename');
    await stopServer(server.child);
  }, 60000);

  it('the backfill pins an existing user to the file already on disk, and moves nothing', async () => {
    // A database from before SB-112: the column is there but empty, exactly as the guarded
    // ALTER leaves every pre-existing row for the instant before the backfill runs.
    const { data, md } = dataDir('slug-backfill');
    let server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(server.port);
    await logAnHour(admin, 'e1-preupgrade');
    expect(mdFiles(md)).toEqual(['timesheet-admin.md']);
    const keysBefore = ledgerKeys(data);
    expect(keysBefore).toEqual([join(md, 'timesheet-admin.md')]);
    await stopServer(server.child);

    withDb(data, (db) => db.prepare("UPDATE users SET mirror_slug = ''").run());

    server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    admin = await adminOn(server.port);
    await logAnHour(admin, 'e2-postupgrade');

    // Nothing moved: same single file, same ledger key, and the pin now holds the value the
    // old live derivation produced.
    expect(mdFiles(md)).toEqual(['timesheet-admin.md']);
    expect(ledgerKeys(data)).toEqual(keysBefore);
    const pinned = withDb(data, (db) => db.prepare('SELECT mirror_slug FROM users WHERE id = 1').get());
    expect(pinned.mirror_slug).toBe('admin');
    await stopServer(server.child);
  }, 60000);

  it('an abandoned path stays a guard-ledger key, so retireMirrors still sweeps it', async () => {
    // The residue case, reached the only way it still can be: an UNPINNED row renamed before the
    // backfill sees it, so the backfill legitimately pins the new name and the old file is left.
    // SB-112's non-negotiable is that such a file is never deleted and never forgotten — it stays
    // a ledger key, and a shape switch retires it by rename like any other.
    const { data, md } = dataDir('slug-residue');
    let server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(server.port);
    await logAnHour(admin, 'e1-residue');
    expect(mdFiles(md)).toEqual(['timesheet-admin.md']);
    const abandoned = readFileSync(join(md, 'timesheet-admin.md'), 'utf8');
    await stopServer(server.child);

    withDb(data, (db) => db.prepare("UPDATE users SET name = 'Renamed Person', mirror_slug = '' WHERE id = 1").run());

    server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    admin = await adminOn(server.port);
    await logAnHour(admin, 'e2-residue');
    expect(mdFiles(md)).toEqual(['timesheet-admin.md', 'timesheet-renamed-person.md']);
    expect(ledgerKeys(data)).toEqual([join(md, 'timesheet-admin.md'), join(md, 'timesheet-renamed-person.md')]);

    const state = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } })).status).toBe(
      200,
    );

    // Both swept, both by rename. Read the bytes back — asserting the names alone would pass
    // against an `unlink`, and these files hold hours.
    expect(mdFiles(md)).toEqual([
      `timesheet-admin.retired-${TODAY}.md`,
      `timesheet-renamed-person.retired-${TODAY}.md`,
    ]);
    expect(readFileSync(join(md, `timesheet-admin.retired-${TODAY}.md`), 'utf8')).toBe(abandoned);
    await stopServer(server.child);
  }, 60000);
});
