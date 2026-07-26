// SB-065 item 1: the mirror never-clobber guard.
//
// The mirror is a write-only export (DB → md). Pointing `mdDir` at an iCloud-synced
// Obsidian vault turned it into a shared mutable file with two writers, no merge and no
// last-writer detection — and on 2026-07-25 the next `PUT /api/state` on this machine
// replaced the other machine's real dataset with this one's demo seed. There was no
// backup.
//
// The guard: TT records a content hash (plus mtime/size) for every mirror file it writes.
// Before writing it re-reads the file; on a mismatch — or on a file it has no record of at
// all — it REFUSES to write and records a sticky block that `/api/state` reports.
//
// Two rulings this file also pins, because both are failure modes worse than the bug:
//   1. a refused mirror write must NOT fail the save — the DB write already succeeded, and
//      a 500 would mean the user cannot save at all;
//   2. the refusal must be STICKY and VISIBLE, not a log line — a quiet stop leaves the
//      mirror drifting while it looks current, which is the exact failure being fixed.
//
// Everything here is asserted against BYTES ON DISK, not against in-memory state: "TT did
// not clobber it" is a claim about the file.
//
// ## Verified red-green: 2026-07-26
//   Against the pre-guard writeMirror (straight to writeFileSync + renameSync), all seven
//   fail, and the clobber test fails on the file contents themselves:
//     FAIL  refuses to overwrite a mirror file that changed on disk since TT wrote it
//     AssertionError: expected '# timesheet\n\ncurrency: kr\nlanguage…' to be
//       '# NOT WRITTEN BY TIME TURTLE\n\nthe o…' // Object.is equality
//       - # NOT WRITTEN BY TIME TURTLE
//       + # timesheet
//       + …
//       + ## 2026-07-26
//       + - 1h | — | Guard | would clobber
//     ❯ tests/mirror-guard.test.js  expect(readFileSync(MIRROR, 'utf8')).toBe(FOREIGN)
//   i.e. the old code really did replace the other machine's file with its own dataset.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './util.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server', 'src', 'index.js');

const children = [];

// A cookie jar bound to one logical session against one server (same shape as
// tests/api.test.js and tests/md-dir-lock.test.js).
function session(port) {
  const jar = new Map();
  return async function req(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`http://localhost:${port}` + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, json };
  };
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(port), TT_SEED_DEMO: '1', TT_ADMIN_PASSWORD: 'testpw', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });
  children.push(child);
  for (let i = 0; i < 100; i++) {
    if (exited !== null) throw new Error(`server on ${port} exited with code ${exited} before becoming ready`);
    try {
      const res = await fetch(`http://localhost:${port}/api/me`);
      if (res.status) return { port, child };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${port} did not become ready`);
}

async function adminOn(port) {
  const admin = session(port);
  const login = await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
  expect(login.status).toBe(200);
  return admin;
}

/** One entry, with a note we can look for in the mirror bytes. */
function entryWith(note) {
  return {
    id: 'guard-' + note.replace(/\W+/g, '-'),
    date: '2026-07-26',
    start: '09:00',
    end: '10:00',
    durMin: 60,
    project: null,
    label: 'Guard',
    note,
    billable: true,
  };
}

const MD_DIR = mkdtempSync(join(tmpdir(), 'tt-guard-md-'));
const DATA_DIR = mkdtempSync(join(tmpdir(), 'tt-guard-data-'));
const MIRROR = join(MD_DIR, 'timesheet-admin.md');

// What a second machine (or a human in Obsidian) leaves behind. Deliberately not valid
// mirror content: if TT ever writes over it, the difference is unmissable.
const FOREIGN = '# NOT WRITTEN BY TIME TURTLE\n\nthe other machine wrote this file, and it is the only copy\n';

let PORT;

beforeAll(async () => {
  ({ port: PORT } = await startServer({ TT_DATA_DIR: DATA_DIR, TT_MD_DIR: MD_DIR }));
}, 30000);

afterAll(() => {
  for (const child of children) if (!child.killed) child.kill('SIGKILL');
});

describe('mirror never-clobber guard', () => {
  it('writes the mirror on a normal save, and keeps writing it on the next one', async () => {
    const admin = await adminOn(PORT);
    const before = await admin('GET', '/api/state');

    const first = await admin('PUT', '/api/state', { entries: [entryWith('first save')] });
    expect(first.status).toBe(200);
    expect(first.json.mirrorError).toBe(null);
    expect(first.json.mirror).toBe(MIRROR);
    expect(readFileSync(MIRROR, 'utf8')).toContain('first save');

    // TT's own file, unchanged since TT wrote it — the guard must let this through, or the
    // mirror would freeze after a single write.
    const second = await admin('PUT', '/api/state', { entries: [entryWith('second save')] });
    expect(second.status).toBe(200);
    expect(second.json.mirrorError).toBe(null);
    const text = readFileSync(MIRROR, 'utf8');
    expect(text).toContain('second save');
    expect(text).not.toContain('first save');
    // nothing is blocked while TT is the only writer
    expect((await admin('GET', '/api/state')).json.mirrorBlocked).toBe(null);
    expect(before.status).toBe(200);
  });

  it('refuses to overwrite a mirror file that changed on disk since TT wrote it', async () => {
    const admin = await adminOn(PORT);
    // the other machine writes. TT is not watching, and must not care what it says.
    writeFileSync(MIRROR, FOREIGN, 'utf8');

    const put = await admin('PUT', '/api/state', { entries: [entryWith('would clobber')] });

    // THE assertion this ticket exists for: the bytes on disk are still the other
    // machine's. Not "in-memory state says we skipped" — the file.
    expect(readFileSync(MIRROR, 'utf8')).toBe(FOREIGN);
    expect(put.status).toBe(200);
  });

  it('the save still succeeds while the mirror is refused — the DB has the new data', async () => {
    const admin = await adminOn(PORT);
    // ruling 1: a refused mirror write is not a failed save. The previous test's PUT is the
    // one under examination; its data must be in the store.
    const state = await admin('GET', '/api/state');
    expect(state.status).toBe(200);
    expect(state.json.entries.map((e) => e.note)).toEqual(['would clobber']);
    // and a further save keeps working, still without touching the file
    const again = await admin('PUT', '/api/state', { entries: [entryWith('still saving')] });
    expect(again.status).toBe(200);
    expect(again.json.version.entries).toBeGreaterThan(0);
    expect(readFileSync(MIRROR, 'utf8')).toBe(FOREIGN);
    expect((await admin('GET', '/api/state')).json.entries.map((e) => e.note)).toEqual(['still saving']);
  });

  it('surfaces the refusal as sticky state on /api/state, and in the PUT response', async () => {
    const admin = await adminOn(PORT);
    // ruling 2: not a log line. State the API reports, so a UI can show it — and it is
    // still there several saves later, because nobody has acknowledged it.
    const state = await admin('GET', '/api/state');
    expect(state.json.mirrorBlocked).toBeTruthy();
    expect(state.json.mirrorBlocked.path).toBe(MIRROR);
    expect(typeof state.json.mirrorBlocked.detectedAt).toBe('string');
    expect(state.json.mirrorBlocked.reason).toMatch(/chang/i);

    const put = await admin('PUT', '/api/state', { entries: [entryWith('sticky')] });
    expect(put.status).toBe(200);
    expect(put.json.mirror).toBe(null);
    expect(put.json.mirrorError).toMatch(/mirror/i);
    expect(put.json.mirrorBlocked.path).toBe(MIRROR);
  });

  it('acknowledging the block lets the next write through', async () => {
    const admin = await adminOn(PORT);
    const ack = await admin('POST', '/api/mirror/acknowledge');
    expect(ack.status).toBe(200);
    expect(ack.json.cleared).toBe(true);
    expect((await admin('GET', '/api/state')).json.mirrorBlocked).toBe(null);
    // the file is STILL the foreign content until a write actually happens — acknowledging
    // is consent to overwrite, not an overwrite.
    expect(readFileSync(MIRROR, 'utf8')).toBe(FOREIGN);

    const put = await admin('PUT', '/api/state', { entries: [entryWith('after ack')] });
    expect(put.status).toBe(200);
    expect(put.json.mirrorError).toBe(null);
    expect(put.json.mirror).toBe(MIRROR);
    const text = readFileSync(MIRROR, 'utf8');
    expect(text).toContain('after ack');
    expect(text).not.toBe(FOREIGN);
    // and the fresh record means the following save is unblocked too
    const next = await admin('PUT', '/api/state', { entries: [entryWith('and again')] });
    expect(next.json.mirrorError).toBe(null);
    expect(readFileSync(MIRROR, 'utf8')).toContain('and again');
  });

  // The 2026-07-25 incident exactly: a mirror file already sitting in the synced folder,
  // written by a machine this TT has never met, and a database holding a different dataset.
  // TT has no record for that path, so it cannot claim it wrote it — refuse.
  it('refuses a pre-existing mirror file it has no record of (the incident scenario)', async () => {
    const mdDir = mkdtempSync(join(tmpdir(), 'tt-guard-vault-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'tt-guard-fresh-'));
    const path = join(mdDir, 'timesheet-admin.md');
    writeFileSync(path, FOREIGN, 'utf8');

    const { port } = await startServer({ TT_DATA_DIR: dataDir, TT_MD_DIR: mdDir });
    const admin = await adminOn(port);
    const put = await admin('PUT', '/api/state', { entries: [entryWith('fresh machine')] });

    expect(put.status).toBe(200);
    expect(readFileSync(path, 'utf8')).toBe(FOREIGN);
    expect(put.json.mirrorBlocked.path).toBe(path);
    expect((await admin('GET', '/api/state')).json.mirrorBlocked.reason).toMatch(/not written/i);
  }, 30000);

  // SB-085 renders the block in Settings → Mirror folder and translates the server's
  // `reason` by EXACT string match (the keys in client/src/i18n.ts are the English
  // strings). Rewording a reason on the server would therefore not break a test or a
  // type — it would just silently drop Norwegian users back to English mid-sentence. Pin
  // both wordings to the keys the client actually carries.
  //
  // ## Verified red-green: 2026-07-26
  //   Reworded ONE i18n key ('was not' → 'was NOT') and the test failed on the containment:
  //     × reports reasons the settings UI can translate verbatim
  //     AssertionError: expected '// i18n — English (default) + Norwegi…' to contain
  //       ''the file was not written by this Ti…'
  it('reports reasons the settings UI can translate verbatim', async () => {
    const i18n = readFileSync(join(ROOT, 'client', 'src', 'i18n.ts'), 'utf8');

    // (a) no stamp at all — the 2026-07-25 incident's shape
    const vaultMd = mkdtempSync(join(tmpdir(), 'tt-guard-reason-vault-'));
    const vaultData = mkdtempSync(join(tmpdir(), 'tt-guard-reason-vault-data-'));
    writeFileSync(join(vaultMd, 'timesheet-admin.md'), FOREIGN, 'utf8');
    const fresh = await adminOn((await startServer({ TT_DATA_DIR: vaultData, TT_MD_DIR: vaultMd })).port);
    await fresh('PUT', '/api/state', { entries: [entryWith('unstamped')] });
    const unstamped = (await fresh('GET', '/api/state')).json.mirrorBlocked;
    expect(unstamped.reason).toBe('the file was not written by this Time Turtle');
    expect(unstamped.lastWrittenAt).toBe(null); // the row says "never written by Time Turtle"

    // (b) TT wrote it once, then someone else did
    const driftMd = mkdtempSync(join(tmpdir(), 'tt-guard-reason-drift-'));
    const driftData = mkdtempSync(join(tmpdir(), 'tt-guard-reason-drift-data-'));
    const drifted = await adminOn((await startServer({ TT_DATA_DIR: driftData, TT_MD_DIR: driftMd })).port);
    await drifted('PUT', '/api/state', { entries: [entryWith('ours')] });
    writeFileSync(join(driftMd, 'timesheet-admin.md'), FOREIGN, 'utf8');
    await drifted('PUT', '/api/state', { entries: [entryWith('theirs')] });
    const changed = (await drifted('GET', '/api/state')).json.mirrorBlocked;
    expect(changed.reason).toBe('the file changed on disk since Time Turtle last wrote it');
    expect(typeof changed.lastWrittenAt).toBe('string'); // the row can date TT's last write

    for (const reason of [unstamped.reason, changed.reason]) expect(i18n).toContain(`'${reason}'`);
  }, 30000);

  // The settings affordance fires POST /api/mirror/acknowledge blind — the button is drawn
  // from state that may be a few seconds stale, and a second tab (or the click landing
  // twice) must not turn into an error the user has to interpret.
  it('acknowledging with nothing blocked is a no-op, not an error', async () => {
    const mdDir = mkdtempSync(join(tmpdir(), 'tt-guard-ack-md-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'tt-guard-ack-data-'));
    const path = join(mdDir, 'timesheet-admin.md');
    const admin = await adminOn((await startServer({ TT_DATA_DIR: dataDir, TT_MD_DIR: mdDir })).port);

    const virgin = await admin('POST', '/api/mirror/acknowledge');
    expect(virgin.status).toBe(200);
    expect(virgin.json).toEqual({ ok: true, cleared: false, path });

    await admin('PUT', '/api/state', { entries: [entryWith('ours')] });
    writeFileSync(path, FOREIGN, 'utf8');
    await admin('PUT', '/api/state', { entries: [entryWith('theirs')] });
    expect((await admin('POST', '/api/mirror/acknowledge')).json.cleared).toBe(true);
    // the second press has nothing left to clear, and still answers 200
    const twice = await admin('POST', '/api/mirror/acknowledge');
    expect(twice.status).toBe(200);
    expect(twice.json.cleared).toBe(false);
    expect((await admin('GET', '/api/state')).json.mirrorBlocked).toBe(null);
    expect(readFileSync(path, 'utf8')).toBe(FOREIGN); // still not written — consent only
  }, 30000);

  // The block has to outlive the process, or a restart silently re-arms the clobber.
  it('the block survives a server restart', async () => {
    const mdDir = mkdtempSync(join(tmpdir(), 'tt-guard-restart-md-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'tt-guard-restart-data-'));
    const path = join(mdDir, 'timesheet-admin.md');

    const first = await startServer({ TT_DATA_DIR: dataDir, TT_MD_DIR: mdDir });
    const a = await adminOn(first.port);
    expect((await a('PUT', '/api/state', { entries: [entryWith('before')] })).json.mirrorError).toBe(null);
    writeFileSync(path, FOREIGN, 'utf8');
    expect((await a('PUT', '/api/state', { entries: [entryWith('blocked')] })).json.mirrorBlocked).toBeTruthy();
    await new Promise((ok) => {
      first.child.on('exit', ok);
      first.child.kill('SIGKILL');
    });

    const second = await startServer({ TT_DATA_DIR: dataDir, TT_MD_DIR: mdDir });
    const b = await adminOn(second.port);
    expect((await b('GET', '/api/state')).json.mirrorBlocked.path).toBe(path);
    expect((await b('PUT', '/api/state', { entries: [entryWith('after restart')] })).status).toBe(200);
    expect(readFileSync(path, 'utf8')).toBe(FOREIGN);
    expect(existsSync(join(mdDir, 'timesheet-admin.md.tmp'))).toBe(false);
  }, 30000);

  // SB-086: `POST /api/projects/:code/rename` writes SEVERAL users' mirrors in one request.
  // It used to swallow every failure into a console.error and answer a bare `{ ok: true }`,
  // so under the SB-065 guard a single rename could put TWO users' mirrors into the sticky
  // blocked state while the caller saw nothing but success. Both halves are asserted here:
  // the response names both blocks, and — the claim that actually matters — neither of the
  // two tampered files was clobbered.
  //
  // ## Verified red-green: 2026-07-26
  //   Against the pre-SB-086 endpoint (`res.json({ ok: true })` with a bare console.error in
  //   the catch), this fails on the report while the file assertions still pass — which is
  //   precisely the bug: the mirrors were already protected, the CALLER was not told.
  //     AssertionError: Target cannot be null or undefined.
  //     ❯ expect(rename.json.mirrorBlocks).toHaveLength(2)   // the field did not exist
  it('a project rename reports EVERY user’s mirror it could not write, and clobbers none', async () => {
    const mdDir = mkdtempSync(join(tmpdir(), 'tt-sb86-md-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'tt-sb86-data-'));
    const { port } = await startServer({ TT_DATA_DIR: dataDir, TT_MD_DIR: mdDir });
    const admin = await adminOn(port);

    // a second user, so the rename really does span two mirrors
    expect(
      (
        await admin('POST', '/api/users', {
          email: 'sb86@timeturtle.local',
          name: 'Sb Eightsix',
          role: 'employee',
          password: 'sb86pw',
        })
      ).status,
    ).toBe(200);
    const emp = session(port);
    expect((await emp('POST', '/api/auth/login', { email: 'sb86@timeturtle.local', password: 'sb86pw' })).status).toBe(
      200,
    );

    const OLD = 'SB86-OLD';
    const NEW = 'SB86-NEW';
    const st = await admin('GET', '/api/state');
    expect(
      (
        await admin('PUT', '/api/state', {
          projects: [...st.json.projects, { code: OLD, name: 'Old', clientId: null, rate: null, billable: true }],
        })
      ).status,
    ).toBe(200);

    // BOTH users log on it, so both are "affected" and both mirrors get written (and stamped)
    const line = (id, date) => ({
      id,
      date,
      start: 540,
      end: 600,
      durMin: null,
      project: OLD,
      label: 'w',
      note: id,
      billable: true,
    });
    expect((await admin('PUT', '/api/state', { entries: [line('sb86-a', '2026-12-01')] })).json.mirrorError).toBe(null);
    expect((await emp('PUT', '/api/state', { entries: [line('sb86-b', '2026-12-02')] })).json.mirrorError).toBe(null);

    const adminMirror = join(mdDir, 'timesheet-admin.md');
    const empMirror = join(mdDir, 'timesheet-sb-eightsix.md');
    expect(existsSync(adminMirror)).toBe(true);
    expect(existsSync(empMirror)).toBe(true);

    // out-of-band tampering on BOTH — a second machine, or a human in Obsidian
    const foreignA = FOREIGN + 'admin copy\n';
    const foreignB = FOREIGN + 'employee copy\n';
    writeFileSync(adminMirror, foreignA, 'utf8');
    writeFileSync(empMirror, foreignB, 'utf8');

    const rename = await admin('POST', `/api/projects/${OLD}/rename`, { to: NEW });

    // 1. the rename ITSELF succeeded — a refused mirror never fails the request, and the
    //    cross-user reconcile still happened in full
    expect(rename.status).toBe(200);
    expect(rename.json.ok).toBe(true);
    expect((await admin('GET', '/api/state')).json.projects.some((p) => p.code === NEW)).toBe(true);
    expect((await emp('GET', '/api/state')).json.entries.find((e) => e.id === 'sb86-b').project).toBe(NEW);

    // 2. …and it SAID SO: both users' blocks are on the response, not only in a log line
    expect(rename.json.mirrorBlocks).toHaveLength(2);
    expect(rename.json.mirrorBlocks.map((b) => b.path).sort()).toEqual([adminMirror, empMirror].sort());
    for (const block of rename.json.mirrorBlocks) {
      expect(block.reason).toMatch(/chang/i);
      expect(typeof block.detectedAt).toBe('string');
    }
    expect(rename.json.mirrorErrors).toHaveLength(2);
    for (const message of rename.json.mirrorErrors) expect(message).toMatch(/mirror refused/i);
    // blind reconcile: the report names paths, never entry content
    expect(JSON.stringify(rename.json)).not.toContain('sb86-b');

    // 3. THE assertion the ticket exists for: neither file was clobbered — the bytes on disk
    expect(readFileSync(adminMirror, 'utf8')).toBe(foreignA);
    expect(readFileSync(empMirror, 'utf8')).toBe(foreignB);

    // 4. and the blocks are sticky per user, reported to each of them by /api/state
    expect((await admin('GET', '/api/state')).json.mirrorBlocked.path).toBe(adminMirror);
    expect((await emp('GET', '/api/state')).json.mirrorBlocked.path).toBe(empMirror);
  }, 30000);

  // SB-095: `/api/state` reports only the SESSION user's block, so an admin could not see —
  // and therefore could not clear — an employee's, even though POST /api/mirror/acknowledge
  // has taken `{userId}` since SB-065. The write was built and unreachable; this is the read.
  //
  // The shape is SB-086's on purpose: several users' blocks come back as a LIST under the
  // plural `mirrorBlocks`, not as a third invention. What it adds is `userId`/`userName`,
  // because the guard is keyed by PATH and the acknowledge call is keyed by USER — a report
  // without the identity is one an admin cannot act on.
  //
  // ## Verified red-green: 2026-07-26
  //   With the route renamed away (so GET /api/mirror/blocks 404s, i.e. the state before this
  //   ticket), it fails on the very first thing it asks — express answering "no such route"
  //   where the surface has to answer "not for you":
  //     × an admin can read every user’s block, and an employee cannot  334ms
  //     AssertionError: expected 404 to be 403 // Object.is equality
  //     ❯ tests/mirror-guard.test.js:487  expect(refused.status).toBe(403)
  it('an admin can read every user’s block, and an employee cannot', async () => {
    const mdDir = mkdtempSync(join(tmpdir(), 'tt-sb95-md-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'tt-sb95-data-'));
    const { port } = await startServer({ TT_DATA_DIR: dataDir, TT_MD_DIR: mdDir });
    const admin = await adminOn(port);

    const created = await admin('POST', '/api/users', {
      email: 'sb95@timeturtle.local',
      name: 'Sb Ninetyfive',
      role: 'employee',
      password: 'sb95pw',
    });
    expect(created.status).toBe(200);
    const empId = created.json.user.id;
    const emp = session(port);
    expect((await emp('POST', '/api/auth/login', { email: 'sb95@timeturtle.local', password: 'sb95pw' })).status).toBe(
      200,
    );

    // both mirrors written and stamped, then both changed underneath, then both refused
    const adminMirror = (await admin('PUT', '/api/state', { entries: [entryWith('a1')] })).json.mirror;
    const empMirror = (await emp('PUT', '/api/state', { entries: [entryWith('e1')] })).json.mirror;
    expect(adminMirror).toBeTruthy();
    expect(empMirror).toBeTruthy();
    const foreignEmp = FOREIGN + 'employee copy\n';
    writeFileSync(adminMirror, FOREIGN + 'admin copy\n', 'utf8');
    writeFileSync(empMirror, foreignEmp, 'utf8');
    expect((await admin('PUT', '/api/state', { entries: [entryWith('a2')] })).json.mirrorBlocked).toBeTruthy();
    expect((await emp('PUT', '/api/state', { entries: [entryWith('e2')] })).json.mirrorBlocked).toBeTruthy();

    // 1. the employee may not read across users — the same 403 every admin surface gives
    const refused = await emp('GET', '/api/mirror/blocks');
    expect(refused.status).toBe(403);

    // 2. the admin sees BOTH, each carrying who it belongs to
    const blocks = await admin('GET', '/api/mirror/blocks');
    expect(blocks.status).toBe(200);
    expect(Object.keys(blocks.json)).toEqual(['mirrorBlocks']); // SB-086's shape, nothing else
    expect(blocks.json.mirrorBlocks.map((b) => b.path).sort()).toEqual([adminMirror, empMirror].sort());
    const empBlock = blocks.json.mirrorBlocks.find((b) => b.path === empMirror);
    expect(empBlock.userId).toBe(empId);
    expect(empBlock.userName).toBe('Sb Ninetyfive');
    expect(empBlock.reason).toMatch(/chang/i);
    // blind, like the rename report: paths and names, never entry content
    expect(JSON.stringify(blocks.json)).not.toContain('e2');

    // 3. and the id it reports is the one the acknowledge route takes — the whole point of
    //    carrying it. Clearing is CONSENT: the employee's file is untouched afterwards.
    const ack = await admin('POST', '/api/mirror/acknowledge', { userId: empBlock.userId });
    expect(ack.status).toBe(200);
    expect(ack.json.cleared).toBe(true);
    expect(readFileSync(empMirror, 'utf8')).toBe(foreignEmp);
    expect((await emp('GET', '/api/state')).json.mirrorBlocked).toBe(null);

    // 4. the read now reports only what is still blocked — the admin's own, which stays
    const after = await admin('GET', '/api/mirror/blocks');
    expect(after.json.mirrorBlocks.map((b) => b.path)).toEqual([adminMirror]);
    expect((await admin('GET', '/api/state')).json.mirrorBlocked.path).toBe(adminMirror);
  }, 30000);
});
