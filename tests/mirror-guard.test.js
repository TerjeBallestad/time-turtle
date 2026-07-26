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
});
