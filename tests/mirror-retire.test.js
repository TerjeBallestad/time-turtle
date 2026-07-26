// SB-056 / DD-011: retiring the v2 mirror files the shape toggle leaves behind.
//
// Under `personal` the mirror stops AND the toggle retires what it already wrote. "Silently stop
// updating" is the one option DD-011 rules out by name: `mdDir` points into an Obsidian vault
// on the machine this was ruled for, so those files sit next to the daily notes, frozen at
// cutover and still looking current — the stale-restore hazard SB-069 accepted risk on.
//
// Everything here is asserted against BYTES ON DISK, in mirror-guard.test.js's shape, because
// "the file was retired, not eaten" is a claim about the file. Asserting only that the old
// name is gone would pass against `unlink`, and DD-011's whole point is that the bytes survive
// under a name that no longer looks current.
//
// The case SB-065 makes dangerous and this file exists to pin: retiring a file TT is REFUSING
// to write. Retirement is rename-only, so an unstamped foreign file comes through byte-identical.
//
// ## Verified red-green: 2026-07-26, RE-RUN by SB-100 under the new names (output TRANSCRIBED
//    from the run, not reconstructed — a renamed transcript that was not re-run is a lying
//    stamp. Each test stops at its FIRST failing assertion, which is what these are.)
//   Making `retireMirrors()` (server/src/markdown.js) `return []` immediately — all 7 fail:
//     FAIL  switching to personal retires the mirror, and the bytes survive under the new name
//           AssertionError: expected [ 'timesheet-admin.md' ] to deeply equal [ Array(1) ]
//     FAIL  a second save under personal retires nothing further …        (same assertion)
//     FAIL  a hand-written file at a user's mirror path is renamed …      (same assertion)
//     FAIL  a sticky block is cleared with its path, so a switch back to team is not wedged
//           AssertionError: expected { …(4) } to be falsy
//     FAIL  a server booted straight into personal sweeps files …         (same assertion)
//     FAIL  retires a file TT wrote under an mdDir that has since moved … (same assertion)
//     FAIL  a second retirement on the same day does not clobber the first (same assertion)
//   i.e. without it the files really do sit there under their current-looking names.
//
//   That mutation stops at the FILENAME assertions, so it does not exercise the byte
//   comparisons — which are the load-bearing half. The mutation that reaches them is the
//   TOMBSTONE, the other shape DD-011 permits and this plan rejected: replace the rename with
//   `writeFileSync(to, '<!-- retired by Time Turtle -->\n'); unlinkSync(path)`. 6 of 7 fail,
//   on content:
//     FAIL  switching to personal retires the mirror, and the bytes survive under the new name
//           AssertionError: expected '<!-- retired by Time Turtle -->\n' to be '# timesheet\n\ncurrency: kr\nlanguage…'
//     FAIL  a hand-written file at a user's mirror path is renamed, never opened
//           AssertionError: expected '<!-- retired by Time Turtle -->\n' to be '# a human wrote this\n\nnothing here …'
//     FAIL  a sticky block is cleared with its path …
//           AssertionError: expected '<!-- retired by Time Turtle -->\n' to be '# edited by another machine\n'
//     (plus the boot-sweep, moved-mdDir and -2-suffix cases, same shape)
//   The one that survives it is the idempotence test, which asserts filenames only — correctly,
//   since that is all it claims.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

/** Log an hour so the mirror is really written, and prove the DB took it. */
async function logAnHour(admin, id) {
  const state = await admin('GET', '/api/state');
  const entry = { id, date: '2026-07-26', start: 540, end: 600, project: null, label: 'retire', note: '', billable: 1 };
  const put = await admin('PUT', '/api/state', { entries: [...state.json.entries, entry] });
  expect(put.status).toBe(200);
  const after = await admin('GET', '/api/state');
  expect(after.json.entries.some((e) => e.id === id)).toBe(true);
  return put;
}

describe('retiring the v2 mirror in the personal shape', () => {
  it('switching to personal retires the mirror, and the bytes survive under the new name', async () => {
    const { data, md } = dataDir('retire-basic');
    const team = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(team.port);
    const put = await logAnHour(admin, 'e1-retire');
    const canonical = put.json.mirror;
    expect(mdFiles(md)).toEqual(['timesheet-admin.md']);
    // What the file held at the moment of cutover. THIS is what has to survive.
    const before = readFileSync(canonical, 'utf8');
    expect(before.length).toBeGreaterThan(0);

    // The switch itself: a settings write, which is also the mirror call that retires.
    const state = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } })).status).toBe(
      200,
    );

    const retiredName = `timesheet-admin.retired-${TODAY}.md`;
    expect(mdFiles(md)).toEqual([retiredName]);
    // Not eaten: byte-for-byte what the canonical file held.
    expect(readFileSync(join(md, retiredName), 'utf8')).toBe(before);
    expect(existsSync(canonical)).toBe(false);
    await stopServer(team.child);
  }, 40000);

  it('a second save under personal retires nothing further — it does not re-retire the retired file', async () => {
    const { data, md } = dataDir('retire-idempotent');
    const team = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(team.port);
    await logAnHour(admin, 'e1-idem');
    const state = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } });
    const afterFirst = mdFiles(md);
    expect(afterFirst).toEqual([`timesheet-admin.retired-${TODAY}.md`]);

    // Two more saves. A retired file is neither stamped nor any user's mirror path, so it must
    // never become a candidate again — `…retired-<date>-2.md` appearing here would mean the
    // retirement is chasing its own tail.
    await logAnHour(admin, 'e2-idem');
    await logAnHour(admin, 'e3-idem');
    expect(mdFiles(md)).toEqual(afterFirst);
    await stopServer(team.child);
  }, 40000);

  it('a hand-written file at a user’s mirror path is renamed, never opened — the SB-065 case', async () => {
    // The file TT is REFUSING to write, because it cannot prove it wrote it. Retirement is
    // rename-only precisely so this is safe; a tombstone line would be a write into it.
    const { data, md } = dataDir('retire-foreign');
    const FOREIGN = '# a human wrote this\n\nnothing here came from Time Turtle.\n';
    mkdirSync(md, { recursive: true });
    writeFileSync(join(md, 'timesheet-admin.md'), FOREIGN, 'utf8');

    const personal = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    const admin = await adminOn(personal.port);
    await logAnHour(admin, 'e1-foreign');

    const retired = mdFiles(md);
    expect(retired).toEqual([`timesheet-admin.retired-${TODAY}.md`]);
    // Read the bytes BACK. Asserting the rename without this is the fake evidence: it would
    // pass against a retirement that renamed and then rewrote.
    expect(readFileSync(join(md, retired[0]), 'utf8')).toBe(FOREIGN);
    await stopServer(personal.child);
  }, 40000);

  it('a sticky block is cleared with its path, so a switch back to team is not wedged', async () => {
    const { data, md } = dataDir('retire-blocked');
    // 1. the team shape writes a mirror, then a foreign hand edits it → the next save blocks.
    const first = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(first.port);
    const put = await logAnHour(admin, 'e1-block');
    writeFileSync(put.json.mirror, '# edited by another machine\n', 'utf8');
    const blocked = await logAnHour(admin, 'e2-block');
    expect(blocked.json.mirrorBlocked).toBeTruthy();
    await stopServer(first.child);

    // 2. switch to personal: the blocked path retires, bytes and all, and the block goes with it.
    const personal = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    admin = await adminOn(personal.port);
    const personalState = await admin('GET', '/api/state');
    expect(personalState.json.mirrorBlocked).toBeFalsy();
    expect(mdFiles(md)).toEqual([`timesheet-admin.retired-${TODAY}.md`]);
    expect(readFileSync(join(md, `timesheet-admin.retired-${TODAY}.md`), 'utf8')).toBe('# edited by another machine\n');
    await stopServer(personal.child);

    // 3. back to team. A block left standing would refuse forever against a file that is not
    // even there — writeMirror rejects a standing block before it looks at the disk at all.
    const back = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    admin = await adminOn(back.port);
    const rewritten = await logAnHour(admin, 'e3-block');
    expect(rewritten.json.mirrorError).toBeFalsy();
    expect(rewritten.json.mirrorBlocked).toBeFalsy();
    expect(rewritten.json.mirror).toBeTruthy();
    // A fresh canonical mirror, alongside the retired one — the guard was not tripped.
    expect(mdFiles(md)).toEqual([`timesheet-admin.md`, `timesheet-admin.retired-${TODAY}.md`]);
    await stopServer(back.child);
  }, 60000);

  it('a server booted straight into personal sweeps files an earlier team run left, with no save at all', async () => {
    // An install switched by TT_SHAPE alone never fires a settings write. Without the boot
    // sweep the files would sit there looking current until somebody happened to save.
    const { data, md } = dataDir('retire-boot');
    const team = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(team.port);
    const put = await logAnHour(admin, 'e1-boot');
    const before = readFileSync(put.json.mirror, 'utf8');
    expect(mdFiles(md)).toEqual(['timesheet-admin.md']);
    await stopServer(team.child);

    const personal = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_SHAPE: 'personal' });
    // NOT logging in, NOT saving — the sweep has to have happened at boot.
    expect(mdFiles(md)).toEqual([`timesheet-admin.retired-${TODAY}.md`]);
    expect(readFileSync(join(md, `timesheet-admin.retired-${TODAY}.md`), 'utf8')).toBe(before);
    await stopServer(personal.child);
  }, 40000);

  it('retires a file TT wrote under an mdDir that has since moved — the ledger, not a glob', async () => {
    // DD-011 requires the rule to hold against the setting moving. The candidate set is the
    // guard ledger UNION the current users' paths, so a file at an OLD mdDir is still caught.
    const { data, md } = dataDir('retire-moved');
    const elsewhere = mkdtempSync(join(tmpdir(), 'tt-retire-moved-old-'));

    const team = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(team.port);
    // write a mirror at `elsewhere`, then move the setting to a different folder
    const state = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, mdDir: elsewhere } })).status).toBe(
      200,
    );
    expect(mdFiles(elsewhere)).toEqual(['timesheet-admin.md']);
    const oldBytes = readFileSync(join(elsewhere, 'timesheet-admin.md'), 'utf8');
    const moved = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...moved.json.settings, mdDir: md } })).status).toBe(200);
    expect(mdFiles(md)).toEqual(['timesheet-admin.md']);

    const now = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...now.json.settings, shape: 'personal' } })).status).toBe(
      200,
    );
    // BOTH are retired: the current path (a live mirrorPath) and the abandoned one (a stamp
    // in the ledger). A glob over the current mdDir would have missed the second entirely.
    expect(mdFiles(md)).toEqual([`timesheet-admin.retired-${TODAY}.md`]);
    expect(mdFiles(elsewhere)).toEqual([`timesheet-admin.retired-${TODAY}.md`]);
    expect(readFileSync(join(elsewhere, `timesheet-admin.retired-${TODAY}.md`), 'utf8')).toBe(oldBytes);
    await stopServer(team.child);
  }, 40000);

  it('a second retirement on the same day does not clobber the first — the -2 suffix', async () => {
    const { data, md } = dataDir('retire-collision');
    const team = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(team.port);
    await logAnHour(admin, 'e1-coll');
    const firstBytes = readFileSync(join(md, 'timesheet-admin.md'), 'utf8');
    let state = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } });
    expect(mdFiles(md)).toEqual([`timesheet-admin.retired-${TODAY}.md`]);

    // back to team, write a DIFFERENT mirror, and retire again the same day
    state = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'team' } });
    await logAnHour(admin, 'e2-coll');
    const secondBytes = readFileSync(join(md, 'timesheet-admin.md'), 'utf8');
    expect(secondBytes).not.toBe(firstBytes);
    state = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', { settings: { ...state.json.settings, shape: 'personal' } });

    expect(mdFiles(md)).toEqual([`timesheet-admin.retired-${TODAY}-2.md`, `timesheet-admin.retired-${TODAY}.md`]);
    // Both retirements survive intact — renameSync would have clobbered the first.
    expect(readFileSync(join(md, `timesheet-admin.retired-${TODAY}.md`), 'utf8')).toBe(firstBytes);
    expect(readFileSync(join(md, `timesheet-admin.retired-${TODAY}-2.md`), 'utf8')).toBe(secondBytes);
    await stopServer(team.child);
  }, 60000);
});
