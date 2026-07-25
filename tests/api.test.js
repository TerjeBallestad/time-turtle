// API role tests (DD-003: roles enforced server-side). Spawns the REAL server
// as a child process against a throwaway data dir with demo seed, then drives it
// over HTTP with a per-session cookie jar. Role claims are proven by an actual
// employee session, never by reading the code.
//
// ## Verified red-green: 2026-07-23
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './util.js';
import TT from '../shared/core.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server', 'src', 'index.js');
const DATA_DIR = mkdtempSync(join(tmpdir(), 'tt-api-'));

// PORT comes from the OS in beforeAll (see freePort). BASE is filled in there too,
// so it must be a mutable binding the helpers below close over.
let child;
let childExited = null;
let BASE;

// A cookie jar bound to one logical session.
function session() {
  const jar = new Map();
  return async function req(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, {
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

async function waitForReady() {
  for (let i = 0; i < 100; i++) {
    // Fail fast on a child that died (e.g. EADDRINUSE) instead of polling to a
    // timeout — otherwise a stray listener answering our probes masks the crash.
    if (childExited !== null) throw new Error(`server exited with code ${childExited} before becoming ready`);
    try {
      const res = await fetch(BASE + '/api/me');
      if (res.status) return; // any HTTP response means it's listening
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

beforeAll(async () => {
  const PORT = await freePort();
  BASE = `http://localhost:${PORT}`;
  child = spawn('node', [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TT_DATA_DIR: DATA_DIR,
      TT_SEED_DEMO: '1',
      TT_ADMIN_PASSWORD: 'testpw',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.on('exit', (code) => {
    childExited = code;
  });
  await waitForReady();
}, 30000);

afterAll(() => {
  if (child && !child.killed) child.kill('SIGKILL');
});

describe('auth + roles', () => {
  it('admin can log in', async () => {
    const admin = session();
    const r = await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    expect(r.status).toBe(200);
    expect(r.json.user.role).toBe('admin');
  });

  it('rejects a wrong password', async () => {
    const r = await session()('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'nope' });
    expect(r.status).toBe(401);
  });

  it('unauthenticated GET /api/state is 401', async () => {
    const r = await session()('GET', '/api/state');
    expect(r.status).toBe(401);
  });

  it('admin GET /api/state exposes numeric rates', async () => {
    const admin = session();
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    const r = await admin('GET', '/api/state');
    expect(r.status).toBe(200);
    // at least one client and one project carry a numeric rate in the seed
    const clientRates = r.json.clients.map((c) => c.rate).filter((x) => x != null);
    const projectRates = r.json.projects.map((p) => p.rate).filter((x) => x != null);
    expect(clientRates.length).toBeGreaterThan(0);
    expect(clientRates.every((x) => typeof x === 'number')).toBe(true);
    expect(projectRates.length).toBeGreaterThan(0);
    expect(projectRates.every((x) => typeof x === 'number')).toBe(true);
  });

  it('admin can create an employee; employee sees all rates as null', async () => {
    const admin = session();
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    const created = await admin('POST', '/api/users', {
      email: 'emp@timeturtle.local',
      name: 'Emp Loyee',
      role: 'employee',
      password: 'emppw',
    });
    expect(created.status).toBe(200);
    expect(created.json.user.role).toBe('employee');

    const emp = session();
    const login = await emp('POST', '/api/auth/login', { email: 'emp@timeturtle.local', password: 'emppw' });
    expect(login.status).toBe(200);
    const state = await emp('GET', '/api/state');
    expect(state.status).toBe(200);
    // rates are stripped server-side, not just hidden in the UI
    expect(state.json.clients.length).toBeGreaterThan(0);
    expect(state.json.clients.every((c) => c.rate === null)).toBe(true);
    expect(state.json.projects.every((p) => p.rate === null)).toBe(true);
  });

  it('employee PUT touching clients is 403', async () => {
    const emp = session();
    await emp('POST', '/api/auth/login', { email: 'emp@timeturtle.local', password: 'emppw' });
    const r = await emp('PUT', '/api/state', { clients: [{ id: 'x', name: 'X', rounding: 'exact', rate: 5 }] });
    expect(r.status).toBe(403);
  });

  it('employee PUT of own entries+templates succeeds, isolates per-user, and does not touch admin data', async () => {
    const admin = session();
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    const before = await admin('GET', '/api/state');
    const adminEntriesBefore = before.json.entries;
    expect(adminEntriesBefore.length).toBeGreaterThan(0);

    // Only an admin can mark a PROJECT non-billable (SDD-002); an employee hour
    // logged against it then derives to nb. This is the sole route to a non-billable
    // employee hour.
    const nbProject = before.json.projects[0].code;
    await admin('PUT', '/api/state', {
      projects: before.json.projects.map((p) => (p.code === nbProject ? { ...p, billable: false } : p)),
    });

    const emp = session();
    await emp('POST', '/api/auth/login', { email: 'emp@timeturtle.local', password: 'emppw' });
    const empState = await emp('GET', '/api/state');
    // a fresh employee owns no templates (the seed's templates belong to the admin)
    expect(empState.json.tasks).toEqual([]);
    const put = await emp('PUT', '/api/state', {
      tasks: [{ id: 'mine', label: 'My template', project: nbProject }],
      entries: [
        {
          id: 'emp1',
          date: '2026-01-05',
          start: 540,
          end: 780,
          durMin: null,
          project: null,
          label: 'freeform',
          note: 'my work',
          billable: true,
        },
        // logged against the admin's nb PROJECT, submitted billable:true — the server derives it to nb
        {
          id: 'emp2',
          date: '2026-01-06',
          start: null,
          end: null,
          durMin: 120,
          project: nbProject,
          label: 'My template',
          note: 'more',
          billable: true,
        },
      ],
    });
    expect(put.status).toBe(200);

    // employee now sees exactly their two entries
    const empAfter = await emp('GET', '/api/state');
    expect(empAfter.json.entries.map((e) => e.note).sort()).toEqual(['more', 'my work']);
    // billable is derived from the entry's project: emp2 → nb project → false; emp1 → no project → true
    expect(empAfter.json.entries.find((e) => e.note === 'more').billable).toBe(false);
    expect(empAfter.json.entries.find((e) => e.note === 'my work').billable).toBe(true);
    // the employee's own template is stored
    expect(empAfter.json.tasks.map((t) => t.id)).toEqual(['mine']);

    // admin's entries AND templates are untouched by the employee's write
    const after = await admin('GET', '/api/state');
    expect(after.json.entries).toEqual(adminEntriesBefore);
    expect(after.json.tasks.every((t) => t.id !== 'mine')).toBe(true);
  });

  it('writes a markdown mirror file under the data dir after a PUT', async () => {
    const mdDir = join(DATA_DIR, 'markdown');
    expect(existsSync(mdDir)).toBe(true);
    const files = readdirSync(mdDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
  });

  // SB-041 (PLAN-008): the pure escaping round-trip is pinned in roundtrip.test.js. This
  // proves the RESTORE PATH end to end — hostile content goes in over HTTP, and the bytes
  // the server actually wrote to disk parse back to the values that went in. A 200 from
  // PUT and the file merely existing prove neither; the assertions below read the file.
  //
  // ## Verified red-green: 2026-07-25
  it('a server-written mirror round-trips a piped client name and a note ending in [nb]', async () => {
    const admin = session();
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    const before = await admin('GET', '/api/state');

    const put = await admin('PUT', '/api/state', {
      clients: [
        ...before.json.clients,
        { id: 'hostile', name: 'Acme | Co', rounding: 'exact', rate: 700, archived: false },
      ],
      projects: [
        ...before.json.projects,
        { code: 'PIPE|X', name: 'Pipe | Project', clientId: 'hostile', rate: null, billable: true, archived: false },
      ],
      entries: [
        ...before.json.entries,
        {
          id: 'hostile1',
          date: '2026-02-02',
          start: null,
          end: null,
          durMin: 60,
          project: 'PIPE|X',
          label: 'Label | With Pipe',
          note: 'refactored the [nb]', // trailing marker is TEXT — the entry stays billable
          billable: true,
        },
      ],
    });
    expect(put.status).toBe(200);

    // read the BYTES on disk (not the in-memory state — that would prove nothing)
    const mdDir = join(DATA_DIR, 'markdown');
    const md = readdirSync(mdDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(mdDir, f), 'utf8'))
      .find((m) => m.includes('2026-02-02'));
    expect(md).toBeTruthy();
    expect(md).toContain('Acme \\| Co'); // escaped on disk…

    const state = TT.parseMd(md);
    expect(state.clients.find((c) => c.id === 'hostile').name).toBe('Acme | Co'); // …decoded back
    expect(state.projects.find((p) => p.code === 'PIPE|X').name).toBe('Pipe | Project');
    const entry = state.entries.find((e) => e.date === '2026-02-02');
    expect(entry.note).toBe('refactored the [nb]');
    expect(entry.billable).toBe(true);
    expect(entry.label).toBe('Label | With Pipe');
    expect(entry.project).toBe('PIPE|X');

    // Restore the catalog: this file runs ONE server against ONE data dir, so leaving a
    // piped project code behind would silently ride along into every later test here.
    // Teardown has to unwind in reference order — SDD-002 ruling 7's hard-delete guard
    // (409) checks each drop against the STORED rows, so entry → project → client, one
    // PUT each. Collapsing them trips the guard, which is it working as designed.
    for (const body of [
      { entries: before.json.entries },
      { projects: before.json.projects },
      { clients: before.json.clients },
    ]) {
      expect((await admin('PUT', '/api/state', body)).status).toBe(200);
    }
    const after = await admin('GET', '/api/state');
    expect(after.json.projects.some((p) => p.code === 'PIPE|X')).toBe(false);
    expect(after.json.clients.some((c) => c.id === 'hostile')).toBe(false);
  });
});

// SDD-002 (DD-003): billable is admin-owned, derived from the PROJECT, and the
// server is the enforcement layer. Every claim is proven by an actual employee
// cookie-jar session and read back with GET — a silent normalize returns 200
// whether it changed the value or not, so the PUT status proves nothing alone.
//
// ## Verified red-green: 2026-07-23
describe('billable is admin-owned, project-derived (SDD-002)', () => {
  const admin = session();
  const emp = session();
  let nbProject; // a project an admin has marked non-billable by default
  let billProject; // a project billable by default

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    // a dedicated employee so writes from other suites don't bleed in
    await admin('POST', '/api/users', {
      email: 'bill@timeturtle.local',
      name: 'Bill Emp',
      role: 'employee',
      password: 'billpw',
    });
    await emp('POST', '/api/auth/login', { email: 'bill@timeturtle.local', password: 'billpw' });
    // admin (and only admin) flips one seeded project's default to non-billable
    const st = await admin('GET', '/api/state');
    nbProject = st.json.projects[0].code;
    billProject = st.json.projects.find((p) => p.code !== nbProject).code;
    const put = await admin('PUT', '/api/state', {
      projects: st.json.projects.map((p) => (p.code === nbProject ? { ...p, billable: false } : p)),
    });
    expect(put.status).toBe(200);
    const back = await admin('GET', '/api/state');
    expect(back.json.projects.find((p) => p.code === nbProject).billable).toBe(false);
  });

  // PUT one entry as the employee (collection-replace, so carry the rest) and read back.
  async function putEntryAndRead(entry) {
    const st = await emp('GET', '/api/state');
    const others = st.json.entries.filter((e) => e.id !== entry.id);
    const put = await emp('PUT', '/api/state', { entries: [...others, entry] });
    expect(put.status).toBe(200);
    const after = await emp('GET', '/api/state');
    return after.json.entries.find((e) => e.id === entry.id);
  }
  const entry = (over) => ({
    id: 'x',
    date: '2026-03-01',
    start: 540,
    end: 600,
    durMin: null,
    project: null,
    label: 'l',
    note: 'n',
    billable: true,
    ...over,
  });

  it('normalizes billable:false on a NEW entry with a billable project back to billable', async () => {
    const stored = await putEntryAndRead(entry({ id: 'b-new', project: billProject, note: 'new', billable: false }));
    expect(stored.billable).toBe(true);
  });

  it('cannot flip an entry already stored as billable to non-billable', async () => {
    await putEntryAndRead(entry({ id: 'b-keep', project: null, note: 'keep', billable: true }));
    const stored = await putEntryAndRead(entry({ id: 'b-keep', project: null, note: 'keep', billable: false }));
    expect(stored.billable).toBe(true);
  });

  it('derives to nb when a projectless stored entry is first given a non-billable project', async () => {
    await putEntryAndRead(entry({ id: 'b-derive', project: null, note: 'derive', billable: true }));
    const stored = await putEntryAndRead(entry({ id: 'b-derive', project: nbProject, note: 'derive', billable: true }));
    expect(stored.billable).toBe(false);
  });

  it('employee cannot flip a project billable default (projects are admin-only → 403)', async () => {
    const st = await emp('GET', '/api/state');
    const put = await emp('PUT', '/api/state', {
      projects: st.json.projects.map((p) => (p.code === nbProject ? { ...p, billable: true } : p)),
    });
    expect(put.status).toBe(403);
    const after = await admin('GET', '/api/state');
    expect(after.json.projects.find((p) => p.code === nbProject).billable).toBe(false);
  });

  it('an ADMIN can set an entry non-billable and it sticks verbatim', async () => {
    const st = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      entries: [
        ...st.json.entries,
        {
          id: 'adm-nb',
          date: '2026-03-05',
          start: 540,
          end: 600,
          durMin: null,
          project: null,
          label: 'l',
          note: 'admin nb',
          billable: false,
        },
      ],
    });
    expect(put.status).toBe(200);
    const after = await admin('GET', '/api/state');
    expect(after.json.entries.find((e) => e.id === 'adm-nb').billable).toBe(false);
  });
});

// SDD-002: task templates are per-user private state. One user's templates never
// appear in another's, and deleting a template can never dangle anyone's entries
// (entries copy label+project at birth — they never reference a template).
//
// ## Verified red-green: 2026-07-23
describe('task templates are per-user and isolated (SDD-002)', () => {
  const admin = session();
  const a = session();
  const b = session();

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'iso-a@timeturtle.local',
      name: 'Iso A',
      role: 'employee',
      password: 'apw',
    });
    await admin('POST', '/api/users', {
      email: 'iso-b@timeturtle.local',
      name: 'Iso B',
      role: 'employee',
      password: 'bpw',
    });
    await a('POST', '/api/auth/login', { email: 'iso-a@timeturtle.local', password: 'apw' });
    await b('POST', '/api/auth/login', { email: 'iso-b@timeturtle.local', password: 'bpw' });
  });

  it('A’s template is absent from B’s state', async () => {
    await a('PUT', '/api/state', { tasks: [{ id: 'a-only', label: 'A only', project: null }] });
    const aState = await a('GET', '/api/state');
    expect(aState.json.tasks.map((t) => t.id)).toContain('a-only');
    const bState = await b('GET', '/api/state');
    expect(bState.json.tasks.map((t) => t.id)).not.toContain('a-only');
  });

  it('A deleting all templates leaves B’s same-id template AND B’s stamped entry intact', async () => {
    // B has a template that happens to share A's id, and a stamped entry (copy at birth)
    await b('PUT', '/api/state', {
      tasks: [{ id: 'a-only', label: 'B copy', project: null }],
      entries: [
        {
          id: 'b-entry',
          date: '2026-04-01',
          start: 540,
          end: 600,
          durMin: null,
          project: 'FJH-NETT',
          label: 'stamped',
          note: 'work',
          billable: true,
        },
      ],
    });
    // A deletes every template they own
    await a('PUT', '/api/state', { tasks: [] });
    const aAfter = await a('GET', '/api/state');
    expect(aAfter.json.tasks).toEqual([]);
    // B is untouched — no cross-user blast radius
    const bAfter = await b('GET', '/api/state');
    expect(bAfter.json.tasks.map((t) => t.id)).toContain('a-only');
    expect(bAfter.json.entries.find((e) => e.id === 'b-entry')).toMatchObject({
      label: 'stamped',
      project: 'FJH-NETT',
    });
  });
});

// SB-010. Every claim below is proven by logging in with the password afterwards —
// a 200 from the change endpoint alone would not show the hash actually moved.
//
// ## Verified red-green: 2026-07-23
describe('passwords', () => {
  /** Log in as admin and return the session. */
  async function adminSession() {
    const s = session();
    const r = await s('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    expect(r.status).toBe(200);
    return s;
  }
  /** Create a throwaway employee and return { id, email, session }. */
  async function makeUser(admin, email, password) {
    const created = await admin('POST', '/api/users', { email, name: 'Pw User', role: 'employee', password });
    expect(created.status).toBe(200);
    const s = session();
    const login = await s('POST', '/api/auth/login', { email, password });
    expect(login.status).toBe(200);
    return { id: created.json.user.id, email, session: s };
  }

  it('self-service change replaces the password: old fails, new works', async () => {
    const admin = await adminSession();
    const user = await makeUser(admin, 'pw1@timeturtle.local', 'oldpw');

    const change = await user.session('POST', '/api/me/password', { currentPassword: 'oldpw', newPassword: 'newpw' });
    expect(change.status).toBe(200);

    expect((await session()('POST', '/api/auth/login', { email: user.email, password: 'oldpw' })).status).toBe(401);
    expect((await session()('POST', '/api/auth/login', { email: user.email, password: 'newpw' })).status).toBe(200);
  });

  it('self-service change with a wrong current password is 401 and leaves the password alone', async () => {
    const admin = await adminSession();
    const user = await makeUser(admin, 'pw2@timeturtle.local', 'keepme');

    const change = await user.session('POST', '/api/me/password', { currentPassword: 'wrong', newPassword: 'hacked' });
    expect(change.status).toBe(401);

    expect((await session()('POST', '/api/auth/login', { email: user.email, password: 'hacked' })).status).toBe(401);
    expect((await session()('POST', '/api/auth/login', { email: user.email, password: 'keepme' })).status).toBe(200);
  });

  it('self-service change rejects an empty new password', async () => {
    const admin = await adminSession();
    const user = await makeUser(admin, 'pw3@timeturtle.local', 'stayput');
    const r = await user.session('POST', '/api/me/password', { currentPassword: 'stayput', newPassword: '' });
    expect(r.status).toBe(400);
    expect((await session()('POST', '/api/auth/login', { email: user.email, password: 'stayput' })).status).toBe(200);
  });

  it('unauthenticated self-service change is 401', async () => {
    const r = await session()('POST', '/api/me/password', { currentPassword: 'x', newPassword: 'y' });
    expect(r.status).toBe(401);
  });

  it('admin reset sets a password without knowing the old one, and keeps the entries', async () => {
    const admin = await adminSession();
    const user = await makeUser(admin, 'pw4@timeturtle.local', 'forgotten');

    // the user has work logged — the whole point of SB-010 is not losing it to a delete+recreate
    const put = await user.session('PUT', '/api/state', {
      entries: [
        {
          id: 'pw4a',
          date: '2026-02-03',
          start: 540,
          end: 600,
          durMin: null,
          task: null,
          note: 'keep me',
          billable: true,
        },
      ],
    });
    expect(put.status).toBe(200);

    const r = await admin('POST', `/api/users/${user.id}/password`, { password: 'resetpw' });
    expect(r.status).toBe(200);

    expect((await session()('POST', '/api/auth/login', { email: user.email, password: 'forgotten' })).status).toBe(401);
    const back = session();
    expect((await back('POST', '/api/auth/login', { email: user.email, password: 'resetpw' })).status).toBe(200);
    const state = await back('GET', '/api/state');
    expect(state.json.entries.map((e) => e.note)).toEqual(['keep me']);
  });

  it('an employee cannot reset another user’s password', async () => {
    const admin = await adminSession();
    const victim = await makeUser(admin, 'pw5@timeturtle.local', 'victimpw');
    const attacker = await makeUser(admin, 'pw6@timeturtle.local', 'attackerpw');

    const r = await attacker.session('POST', `/api/users/${victim.id}/password`, { password: 'pwned' });
    expect(r.status).toBe(403);

    expect((await session()('POST', '/api/auth/login', { email: victim.email, password: 'pwned' })).status).toBe(401);
    expect((await session()('POST', '/api/auth/login', { email: victim.email, password: 'victimpw' })).status).toBe(
      200,
    );
  });

  it('admin reset of an unknown user is 404, and an empty password is 400', async () => {
    const admin = await adminSession();
    expect((await admin('POST', '/api/users/999999/password', { password: 'x' })).status).toBe(404);
    const user = await makeUser(admin, 'pw7@timeturtle.local', 'intact');
    expect((await admin('POST', `/api/users/${user.id}/password`, { password: '' })).status).toBe(400);
    expect((await session()('POST', '/api/auth/login', { email: user.email, password: 'intact' })).status).toBe(200);
  });
});

// SB-013: a per-user token_version is signed into every session token and bumped on
// each password change, so tokens minted before the change stop verifying. The
// self-service path re-issues a fresh cookie so the caller stays logged in. Cookies
// are captured raw here — independently of the auto-updating jar — so 'the old cookie'
// is a fixed value the server's re-issue cannot silently swap under the test.
//
// ## Verified red-green: 2026-07-23
describe('password change invalidates existing sessions (SB-013)', () => {
  async function adminSession() {
    const s = session();
    const r = await s('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    expect(r.status).toBe(200);
    return s;
  }
  // Log in with a bare fetch and hand back the raw Set-Cookie value, so the caller
  // holds a fixed cookie that a later server-side re-issue cannot replace.
  async function loginRaw(email, password) {
    const res = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, cookie };
  }
  const stateWith = (cookie) => fetch(BASE + '/api/state', { headers: { cookie } }).then((r) => r.status);

  it('admin reset logs the target out of their existing session', async () => {
    const admin = await adminSession();
    const created = await admin('POST', '/api/users', {
      email: 'sb13a@timeturtle.local',
      name: 'Reset Target',
      role: 'employee',
      password: 'origpw',
    });
    expect(created.status).toBe(200);

    const old = await loginRaw('sb13a@timeturtle.local', 'origpw');
    expect(old.status).toBe(200);
    expect(await stateWith(old.cookie)).toBe(200); // valid before the reset

    expect((await admin('POST', `/api/users/${created.json.user.id}/password`, { password: 'resetpw' })).status).toBe(
      200,
    );

    expect(await stateWith(old.cookie)).toBe(401); // the pre-reset cookie is dead
    const fresh = await loginRaw('sb13a@timeturtle.local', 'resetpw');
    expect(fresh.status).toBe(200);
    expect(await stateWith(fresh.cookie)).toBe(200); // a freshly issued one works
  });

  it('self-service change kills the old cookie but keeps the caller logged in', async () => {
    const admin = await adminSession();
    await admin('POST', '/api/users', {
      email: 'sb13b@timeturtle.local',
      name: 'Self Change',
      role: 'employee',
      password: 'origpw',
    });

    const old = await loginRaw('sb13b@timeturtle.local', 'origpw');
    expect(old.status).toBe(200);

    // change through a jar session so the re-issued cookie is captured automatically
    const jar = session();
    await jar('POST', '/api/auth/login', { email: 'sb13b@timeturtle.local', password: 'origpw' });
    const change = await jar('POST', '/api/me/password', { currentPassword: 'origpw', newPassword: 'nextpw' });
    expect(change.status).toBe(200);

    expect(await stateWith(old.cookie)).toBe(401); // the cookie from before the change is rejected
    expect((await jar('GET', '/api/state')).status).toBe(200); // caller stays logged in via the re-issued cookie
  });
});

// SB-009. Depends on the block above having created emp@timeturtle.local and PUT
// its two entries: 2026-01-05 09:00→13:00 billable, 2026-01-06 2h non-billable.
//
// ## Verified red-green: 2026-07-23
// Broken three ways, each failing only its own test: dropped requireAdmin (403 →
// 200), dropped the `from` bound (range test), leaked `note` onto a row (shape test).
describe('team report (admin aggregate)', () => {
  async function adminSession() {
    const admin = session();
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    return admin;
  }
  async function employeeId(admin) {
    const users = await admin('GET', '/api/users');
    return users.json.users.find((u) => u.email === 'emp@timeturtle.local').id;
  }

  it('is 401 unauthenticated and 403 for an employee', async () => {
    expect((await session()('GET', '/api/reports/team')).status).toBe(401);

    const emp = session();
    await emp('POST', '/api/auth/login', { email: 'emp@timeturtle.local', password: 'emppw' });
    const r = await emp('GET', '/api/reports/team');
    expect(r.status).toBe(403);
    expect(r.json.rows).toBeUndefined();
  });

  it('rejects a malformed date range', async () => {
    const admin = await adminSession();
    expect((await admin('GET', '/api/reports/team?from=05-01-2026')).status).toBe(400);
    expect((await admin('GET', '/api/reports/team?to=nonsense')).status).toBe(400);
  });

  it('spans more than one user and sums the employee correctly', async () => {
    const admin = await adminSession();
    const empId = await employeeId(admin);
    const r = await admin('GET', '/api/reports/team');
    expect(r.status).toBe(200);
    expect(r.json.from).toBe(null);
    expect(r.json.to).toBe(null);

    // genuinely cross-user: the admin's seeded entries and the employee's both land
    expect(new Set(r.json.rows.map((row) => row.userId)).size).toBeGreaterThan(1);

    // SDD-002: entries own their project, so the two employee entries now bucket
    // separately — emp1 is projectless + billable (240 min), emp2 is on an nb
    // project (120 min, non-billable → no money).
    const empRows = r.json.rows.filter((row) => row.userId === empId);
    expect(empRows).toHaveLength(2);
    expect(empRows.find((row) => row.project === null)).toMatchObject({
      userName: 'Emp Loyee',
      clientId: null,
      min: 240,
      bill: 240,
      amount: 0,
      entries: 1,
    });
    expect(empRows.find((row) => row.project !== null)).toMatchObject({
      userName: 'Emp Loyee',
      min: 120,
      bill: 0,
      amount: 0,
      entries: 1,
    });
  });

  it('aggregates only — no raw entry fields cross the wire', async () => {
    const admin = await adminSession();
    const r = await admin('GET', '/api/reports/team');
    const allowed = ['userId', 'userName', 'project', 'clientId', 'min', 'bill', 'amount', 'entries'];
    for (const row of r.json.rows) expect(Object.keys(row).sort()).toEqual([...allowed].sort());
    // the employee's note text must not appear anywhere in the payload
    expect(JSON.stringify(r.json)).not.toContain('my work');
  });

  it('honours an inclusive from/to range', async () => {
    const admin = await adminSession();
    const empId = await employeeId(admin);
    const r = await admin('GET', '/api/reports/team?from=2026-01-05&to=2026-01-05');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ from: '2026-01-05', to: '2026-01-05' });
    // 2026-01-05 only → just emp1 (projectless, 240 min, billable)
    const empRows = r.json.rows.filter((row) => row.userId === empId);
    expect(empRows).toHaveLength(1);
    expect(empRows[0]).toMatchObject({ project: null, min: 240, bill: 240, entries: 1 });

    // the far side of the range is excluded, and the bound itself is inclusive: both
    // days → two buckets (emp1 on 01-05, emp2 on 01-06), one entry each
    const both = await admin('GET', '/api/reports/team?from=2026-01-05&to=2026-01-06');
    const bothRows = both.json.rows.filter((row) => row.userId === empId);
    expect(bothRows).toHaveLength(2);
    expect(bothRows.reduce((n, row) => n + row.entries, 0)).toBe(2);
    const neither = await admin('GET', '/api/reports/team?from=2026-01-07&to=2026-01-08');
    expect(neither.json.rows.filter((row) => row.userId === empId)).toHaveLength(0);
  });
});

// SDD-002 ruling 3/4/5/8 (DD-003): the commit step. Every claim is proven from a real
// EMPLOYEE cookie-jar session and read back with GET — a silent normalize/pin returns
// 200 whether it changed anything or not, so a PUT status proves nothing on its own.
// The money-freeze is proven by actually changing the rate BETWEEN two reads.
//
// ## Verified red-green: 2026-07-24
// break 1 — stateFor returns full commits for employees → 'money snapshot stripped' fails
// break 2 — skip pinCommittedEntries → 'read-only committed segment' edits stick, fails
// break 3 — reports use TT.amount not effectiveAmount → 'committed month frozen' fails
describe('commit step: ledger, employee read-only, frozen money (SDD-002)', () => {
  const admin = session();
  const emp = session();
  const PROJ = 'R8-PROJ'; // a dedicated project so a rate change touches nothing else
  const A = {
    id: 'r8a',
    date: '2026-05-04',
    start: 540,
    end: 660,
    durMin: null,
    project: PROJ,
    label: 'work',
    note: 'may',
    billable: true,
  };
  const B = {
    id: 'r8b',
    date: '2026-06-01',
    start: 540,
    end: 660,
    durMin: null,
    project: PROJ,
    label: 'work',
    note: 'jun',
    billable: true,
  };
  const keyA = TT.segmentKey(A.date); // committed
  const keyB = TT.segmentKey(B.date); // left uncommitted
  let empId;

  async function empEntries() {
    return (await emp('GET', '/api/state')).json.entries;
  }
  async function empRowFor(range) {
    const r = await admin('GET', '/api/reports/team' + range);
    return r.json.rows.find((row) => row.userId === empId && row.project === PROJ);
  }

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'r8@timeturtle.local',
      name: 'Ruling Eight',
      role: 'employee',
      password: 'r8pw',
    });
    await emp('POST', '/api/auth/login', { email: 'r8@timeturtle.local', password: 'r8pw' });
    empId = (await admin('GET', '/api/users')).json.users.find((u) => u.email === 'r8@timeturtle.local').id;
    // admin appends a rated, client-less, billable project (rateOf = 1000, exact rounding)
    const st = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      projects: [...st.json.projects, { code: PROJ, name: 'Ruling Eight', clientId: null, rate: 1000, billable: true }],
    });
    expect(put.status).toBe(200);
    // employee logs two 120-min billable hours (May + June), then commits ONLY May
    await emp('PUT', '/api/state', { entries: [A, B] });
    const commit = await emp('PUT', '/api/state', { entries: [A, B], commits: [{ key: keyA }] });
    expect(commit.status).toBe(200);
  });

  it('an employee sees their commit with a server committedAt and NO money snapshot', async () => {
    const state = (await emp('GET', '/api/state')).json;
    expect(state.commits).toHaveLength(1);
    const seg = state.commits[0];
    expect(seg.key).toBe(keyA);
    // committedAt is a real server-stamped ISO string (the client never sent one)
    expect(typeof seg.committedAt).toBe('string');
    expect(Number.isNaN(Date.parse(seg.committedAt))).toBe(false);
    // the per-entry money snapshot is stripped for the employee (server strip, not a UI hide)
    expect(seg.snapshot).toEqual({});
    // and rates are still stripped everywhere, so an employee can't reconstruct money
    expect(state.projects.every((p) => p.rate === null)).toBe(true);
  });

  it('freezes the per-entry money snapshot server-side and writes it into the markdown mirror', async () => {
    // The employee's own /api/state has the snapshot stripped (proven above). The mirror
    // is written server-side from the UNstripped ledger, so it must carry the frozen money
    // rows — which proves the snapshot is real and server-derived, not merely absent.
    const mdDir = join(DATA_DIR, 'markdown');
    const files = readdirSync(mdDir).filter((f) => f.endsWith('.md'));
    const empFile = files.map((f) => readFileSync(join(mdDir, f), 'utf8')).find((t) => t.includes(keyA));
    expect(empFile).toBeDefined();
    expect(empFile).toContain('## commits');
    // the segment header…
    expect(empFile).toMatch(new RegExp('- ' + keyA + ' \\| '));
    // …and the indented per-entry snapshot row: r8a is a 120-min entry on R8-PROJ (rate
    // 1000, exact rounding) → rate 1000 | billMin 120 | amount 2000, frozen at commit.
    expect(empFile).toMatch(/- r8a \| 1000 \| 120 \| 2000/);
  });

  it('a committed segment is READ-ONLY for the employee: edits, adds and deletes are all reverted', async () => {
    // 1. try to EDIT the committed entry (change time + note)
    await emp('PUT', '/api/state', { entries: [{ ...A, start: 0, end: 60, note: 'HACKED' }, B] });
    let entries = await empEntries();
    let a = entries.find((e) => e.id === 'r8a');
    expect(a).toMatchObject({ start: 540, end: 660, note: 'may' }); // unchanged

    // 2. try to ADD a new entry inside the committed segment
    const add = {
      id: 'r8-add',
      date: '2026-05-05',
      start: 540,
      end: 600,
      durMin: null,
      project: PROJ,
      label: 'x',
      note: 'sneak',
      billable: true,
    };
    await emp('PUT', '/api/state', { entries: [A, B, add] });
    entries = await empEntries();
    expect(entries.some((e) => e.id === 'r8-add')).toBe(false); // add dropped

    // 3. try to DELETE the committed entry (omit it from the collection-replace)
    await emp('PUT', '/api/state', { entries: [B] });
    entries = await empEntries();
    expect(entries.some((e) => e.id === 'r8a')).toBe(true); // delete re-inserted
    // meanwhile the UNCOMMITTED entry B is freely editable
    await emp('PUT', '/api/state', { entries: [A, { ...B, note: 'jun-edited' }] });
    entries = await empEntries();
    expect(entries.find((e) => e.id === 'r8b').note).toBe('jun-edited');
  });

  it('the team report freezes a committed month against a later rate change while an uncommitted month moves', async () => {
    // both months bill 120 min; live money at rate 1000 = 2000
    const mayBefore = await empRowFor('?from=2026-05-01&to=2026-05-31');
    const junBefore = await empRowFor('?from=2026-06-01&to=2026-06-30');
    expect(mayBefore).toMatchObject({ bill: 120, amount: 2000 });
    expect(junBefore).toMatchObject({ bill: 120, amount: 2000 });

    // admin renegotiates the project rate 1000 → 3000
    const st = await admin('GET', '/api/state');
    const bump = await admin('PUT', '/api/state', {
      projects: st.json.projects.map((p) => (p.code === PROJ ? { ...p, rate: 3000 } : p)),
    });
    expect(bump.status).toBe(200);

    const mayAfter = await empRowFor('?from=2026-05-01&to=2026-05-31');
    const junAfter = await empRowFor('?from=2026-06-01&to=2026-06-30');
    expect(mayAfter.amount).toBe(2000); // COMMITTED month frozen — the snapshot wins
    expect(junAfter.amount).toBe(6000); // UNCOMMITTED month follows the new rate (120/60 * 3000)
  });

  it('un-committing frees the segment so the same edit now persists', async () => {
    // un-commit May (send an empty ledger); the snapshot is discarded
    const un = await emp('PUT', '/api/state', { entries: [A, B], commits: [] });
    expect(un.status).toBe(200);
    expect((await emp('GET', '/api/state')).json.commits).toEqual([]);
    // the edit that was reverted while committed now sticks
    await emp('PUT', '/api/state', { entries: [{ ...A, note: 'now-editable' }, B] });
    const a = (await empEntries()).find((e) => e.id === 'r8a');
    expect(a.note).toBe('now-editable');
  });
});

// SDD-002 ruling 6 (SB-025, PLAN-007): the admin cross-user read + line-edit path. Every
// role claim is proven from a real EMPLOYEE cookie-jar session; the re-freeze is proven by
// bumping the rate BETWEEN commit and the admin edit and reading the frozen amounts back.
//
// ## Verified red-green: 2026-07-24
// break 1 — drop requireAdmin on the timesheet/entries routes → the employee-403 tests fail
// break 2 — re-derive EVERY segment (ignore `affected`) → June's frozen 2000 becomes 6000, fails
// break 3 — never set editedByAdmin → the 'edited-by-admin marker' assertion fails
// break 4 — drop pinEditedByAdmin → the employee's forged marker sticks, 'cannot forge' fails
describe('admin cross-user review & edit (SDD-002 ruling 6)', () => {
  const admin = session();
  const emp = session();
  const PROJ = 'RC6-PROJ';
  const MAY = {
    id: 'rc6a',
    date: '2026-05-04',
    start: 540,
    end: 660,
    durMin: null,
    project: PROJ,
    label: 'work',
    note: 'may',
    billable: true,
  };
  const JUN = {
    id: 'rc6b',
    date: '2026-06-01',
    start: 540,
    end: 660,
    durMin: null,
    project: PROJ,
    label: 'work',
    note: 'jun',
    billable: true,
  };
  const keyMay = TT.segmentKey(MAY.date);
  const keyJun = TT.segmentKey(JUN.date);
  let empId;

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'rc6@timeturtle.local',
      name: 'Ruling Six',
      role: 'employee',
      password: 'rc6pw',
    });
    await emp('POST', '/api/auth/login', { email: 'rc6@timeturtle.local', password: 'rc6pw' });
    empId = (await admin('GET', '/api/users')).json.users.find((u) => u.email === 'rc6@timeturtle.local').id;
    // rated (1000/h, exact), client-less, billable project so the rate bump touches nothing else
    const st = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', {
      projects: [...st.json.projects, { code: PROJ, name: 'Ruling Six', clientId: null, rate: 1000, billable: true }],
    });
    // employee logs two 120-min hours and commits BOTH segments (May + June)
    const commit = await emp('PUT', '/api/state', { entries: [MAY, JUN], commits: [{ key: keyMay }, { key: keyJun }] });
    expect(commit.status).toBe(200);
  });

  it('admin GET /api/users/:id/timesheet reads the employee’s entries with money-present commits', async () => {
    const r = await admin('GET', `/api/users/${empId}/timesheet`);
    expect(r.status).toBe(200);
    expect(r.json.entries.map((e) => e.id).sort()).toEqual(['rc6a', 'rc6b']);
    const may = r.json.commits.find((c) => c.key === keyMay);
    // money is PRESENT for the admin (the SB-009 crossing): 120 min @ 1000 = 2000
    expect(may.snapshot.rc6a).toEqual({ rate: 1000, billMin: 120, amount: 2000 });
  });

  it('an EMPLOYEE hitting the admin review endpoints is 403 (even for their own id)', async () => {
    expect((await emp('GET', `/api/users/${empId}/timesheet`)).status).toBe(403);
    expect((await emp('PUT', `/api/users/${empId}/entries`, { entries: [MAY, JUN] })).status).toBe(403);
  });

  it('admin corrects a committed line: re-freezes ONLY that segment, marks it edited, leaves other months verbatim', async () => {
    // renegotiate the rate 1000 → 3000 AFTER both months are committed
    const st = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', {
      projects: st.json.projects.map((p) => (p.code === PROJ ? { ...p, rate: 3000 } : p)),
    });
    // admin corrects the MAY entry only: 120 min → 180 min (end 660 → 720)
    const put = await admin('PUT', `/api/users/${empId}/entries`, { entries: [{ ...MAY, end: 720 }, JUN] });
    expect(put.status).toBe(200);

    const after = await admin('GET', `/api/users/${empId}/timesheet`);
    const may = after.json.commits.find((c) => c.key === keyMay);
    const jun = after.json.commits.find((c) => c.key === keyJun);
    // MAY re-frozen from the corrected entry at the LIVE rate: 180 min @ 3000 = 9000
    expect(may.snapshot.rc6a).toEqual({ rate: 3000, billMin: 180, amount: 9000 });
    // JUN was NOT touched by the edit — its frozen money stays VERBATIM (ruling 8), NOT 6000
    expect(jun.snapshot.rc6b).toEqual({ rate: 1000, billMin: 120, amount: 2000 });
    // the corrected line is marked edited-by-admin; the untouched line is not
    expect(after.json.entries.find((e) => e.id === 'rc6a').editedByAdmin).toBe(true);
    expect(after.json.entries.find((e) => e.id === 'rc6b').editedByAdmin).toBeFalsy();
  });

  it('the admin correction never leaks money back to the employee (own /api/state still stripped)', async () => {
    const state = (await emp('GET', '/api/state')).json;
    expect(state.projects.every((p) => p.rate === null)).toBe(true);
    for (const seg of state.commits) expect(seg.snapshot).toEqual({});
    // the corrected entry reaches the employee (edited-by-admin marker visible) but carries no money
    const a = state.entries.find((e) => e.id === 'rc6a');
    expect(a.editedByAdmin).toBe(true);
    expect(a.end).toBe(720); // the correction persisted for the employee
  });

  it('404s an unknown target user', async () => {
    expect((await admin('GET', '/api/users/999999/timesheet')).status).toBe(404);
    expect((await admin('PUT', '/api/users/999999/entries', { entries: [] })).status).toBe(404);
  });

  it('an employee cannot forge the edited-by-admin marker via their own /api/state PUT', async () => {
    // editedByAdmin is server-authoritative (set only by the admin cross-user path). A fresh,
    // UNcommitted entry the employee sends with editedByAdmin:true must come back false.
    const forged = {
      id: 'rc6-forge',
      date: '2026-08-03',
      start: 540,
      end: 600,
      durMin: null,
      project: PROJ,
      label: 'x',
      note: 'mine',
      billable: true,
      editedByAdmin: true,
    };
    const put = await emp('PUT', '/api/state', { entries: [{ ...MAY, end: 720 }, JUN, forged] });
    expect(put.status).toBe(200);
    const mine = (await emp('GET', '/api/state')).json.entries.find((e) => e.id === 'rc6-forge');
    expect(mine).toBeDefined();
    expect(mine.editedByAdmin).toBeFalsy(); // the server refused the forged marker
  });
});

// SDD-002 grand-review fix (PLAN-007): two defects in the admin cross-user edit path.
//   Defect 1 — a correction to ONE line in a committed week must not re-price the OTHER
//   lines in that same week at a rate that changed since commit (ruling 8). The old handler
//   re-derived the WHOLE segment, so an untouched line silently moved (2000 → 6000).
//   Defect 2 — the blind full-collection replace had no concurrency guard: an employee
//   logging an hour after the Review tab loaded was silently deleted on the admin's save.
//
// ## Verified red-green: 2026-07-24
// defect 1 — revert to `snapshot: deriveSnapshot(catalog, marked, seg.key)` → the untouched
//   same-week line re-prices to 6000 and 'preserves the untouched line' fails.
// defect 2 — drop the `expected?.entries` guard in the transaction → the stale admin PUT
//   returns 200, the employee's new entry is deleted, and 'stale PUT 409s' fails.
describe('SDD-002 grand-review fix: partial re-freeze + optimistic concurrency', () => {
  const admin = session();
  const emp = session();
  const PROJ = 'GRF-PROJ';
  // two 120-min lines in the SAME week (both fall in one segment)
  const A = {
    id: 'grf-a',
    date: '2026-09-07',
    start: 540,
    end: 660,
    durMin: null,
    project: PROJ,
    label: 'a',
    note: '',
    billable: true,
  };
  const B = {
    id: 'grf-b',
    date: '2026-09-08',
    start: 540,
    end: 660,
    durMin: null,
    project: PROJ,
    label: 'b',
    note: '',
    billable: true,
  };
  const key = TT.segmentKey(A.date);
  let empId;

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'grf@timeturtle.local',
      name: 'Grand Review',
      role: 'employee',
      password: 'grfpw',
    });
    await emp('POST', '/api/auth/login', { email: 'grf@timeturtle.local', password: 'grfpw' });
    empId = (await admin('GET', '/api/users')).json.users.find((u) => u.email === 'grf@timeturtle.local').id;
    const st = await admin('GET', '/api/state');
    // isolated project @ 1000/h exact so a later rate bump touches nothing else
    await admin('PUT', '/api/state', {
      projects: [...st.json.projects, { code: PROJ, name: 'Grand Review', clientId: null, rate: 1000, billable: true }],
    });
    // employee logs both lines and commits the single week they share
    const commit = await emp('PUT', '/api/state', { entries: [A, B], commits: [{ key }] });
    expect(commit.status).toBe(200);
    TT.segmentKey(B.date); // both lines share `key` — assert it so the setup is honest
    expect(TT.segmentKey(B.date)).toBe(key);
  });

  it('admin edits ONE line in a committed week: only that line re-freezes; the untouched same-week line keeps its old frozen row byte-for-byte', async () => {
    // both lines are frozen at 1000/h: 120 min = 2000 each
    const before = await admin('GET', `/api/users/${empId}/timesheet`);
    expect(before.json.commits.find((c) => c.key === key).snapshot).toEqual({
      'grf-a': { rate: 1000, billMin: 120, amount: 2000 },
      'grf-b': { rate: 1000, billMin: 120, amount: 2000 },
    });
    // renegotiate 1000 → 3000 AFTER the week is committed
    const st = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', {
      projects: st.json.projects.map((p) => (p.code === PROJ ? { ...p, rate: 3000 } : p)),
    });
    // admin corrects line A only (120 → 180 min); B is sent verbatim
    const put = await admin('PUT', `/api/users/${empId}/entries`, { entries: [{ ...A, end: 720 }, B] });
    expect(put.status).toBe(200);

    const after = await admin('GET', `/api/users/${empId}/timesheet`);
    const snap = after.json.commits.find((c) => c.key === key).snapshot;
    // A re-freezes at the LIVE rate: 180 min @ 3000 = 9000
    expect(snap['grf-a']).toEqual({ rate: 3000, billMin: 180, amount: 9000 });
    // B was NOT touched — its frozen row stays VERBATIM (ruling 8), NOT 6000
    expect(snap['grf-b']).toEqual({ rate: 1000, billMin: 120, amount: 2000 });
  });

  it('a stale admin PUT 409s and the employee’s meanwhile-logged entry survives; a fresh re-GET + PUT succeeds', async () => {
    // admin loads the timesheet (captures the version)
    const loaded = await admin('GET', `/api/users/${empId}/timesheet`);
    const staleVersion = loaded.json.version;
    // the employee logs a NEW entry via their own /api/state — bumps the entries version
    const NEW = {
      id: 'grf-c',
      date: '2026-09-14',
      start: 540,
      end: 600,
      durMin: null,
      project: PROJ,
      label: 'c',
      note: '',
      billable: true,
    };
    const empPut = await emp('PUT', '/api/state', {
      entries: [{ ...A, end: 720 }, B, NEW],
      commits: [{ key }],
    });
    expect(empPut.status).toBe(200);
    // the admin saves against the STALE version → 409, nothing written
    const stale = await admin('PUT', `/api/users/${empId}/entries`, {
      entries: [
        { ...A, end: 720, label: 'admin-fix' },
        { ...B, end: 720 },
      ],
      version: staleVersion,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.conflict).toBe(true);
    // the employee's new entry SURVIVED — the blind replace did not delete it
    const survived = await admin('GET', `/api/users/${empId}/timesheet`);
    expect(survived.json.entries.map((e) => e.id).sort()).toEqual(['grf-a', 'grf-b', 'grf-c']);
    // a version-less PUT still writes (backward-compat): re-GET fresh, then save with the fresh version → 200
    const fresh = survived.json.version;
    const ok = await admin('PUT', `/api/users/${empId}/entries`, {
      entries: survived.json.entries.map((e) => (e.id === 'grf-a' ? { ...e, label: 'admin-fix' } : e)),
      version: fresh,
    });
    expect(ok.status).toBe(200);
    const final = await admin('GET', `/api/users/${empId}/timesheet`);
    expect(final.json.entries.find((e) => e.id === 'grf-a').label).toBe('admin-fix');
    expect(final.json.entries.find((e) => e.id === 'grf-a').editedByAdmin).toBe(true);
  });
});

// SDD-002 ruling 5 (SB-025, PLAN-007): Approve locks a committed segment / Release reopens
// it. The whole point — an EMPLOYEE can no longer un-commit an approved segment — is proven
// from a real employee cookie-jar session: the drop returns 200 but the re-GET shows the
// segment STILL committed. The segment is proven committed BEFORE approve so the refusal is
// meaningful, and approvedAt is read from the EMPLOYEE's own /api/state (never the admin's).
//
// ## Verified red-green: 2026-07-24
// break 1 — drop the reconcile force-keep → 'employee cannot un-commit approved' fails (drop sticks)
// break 2 — drop approvedAt from the stateFor employee strip → 'approvedAt reaches employee' fails
// break 3 — drop requireAdmin on approve/release → 'employee approve/release 403' fails
describe('approve/release lock (SDD-002 ruling 5)', () => {
  const admin = session();
  const emp = session();
  const PROJ = 'RC5-PROJ';
  const E = {
    id: 'rc5a',
    date: '2026-07-06',
    start: 540,
    end: 660,
    durMin: null,
    project: PROJ,
    label: 'work',
    note: 'jul',
    billable: true,
  };
  const keyE = TT.segmentKey(E.date);
  let empId;
  const empCommits = async () => (await emp('GET', '/api/state')).json.commits;

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'rc5@timeturtle.local',
      name: 'Ruling Five',
      role: 'employee',
      password: 'rc5pw',
    });
    await emp('POST', '/api/auth/login', { email: 'rc5@timeturtle.local', password: 'rc5pw' });
    empId = (await admin('GET', '/api/users')).json.users.find((u) => u.email === 'rc5@timeturtle.local').id;
    const st = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', {
      projects: [...st.json.projects, { code: PROJ, name: 'Ruling Five', clientId: null, rate: 1000, billable: true }],
    });
    await emp('PUT', '/api/state', { entries: [E], commits: [{ key: keyE }] });
  });

  it('the segment starts committed and NOT yet approved (a meaningful baseline)', async () => {
    const commits = await empCommits();
    const seg = commits.find((c) => c.key === keyE);
    expect(seg).toBeDefined();
    expect(seg.approvedAt).toBeUndefined();
  });

  it('an employee cannot approve or release a segment (403)', async () => {
    expect((await emp('POST', `/api/users/${empId}/segments/${keyE}/approve`)).status).toBe(403);
    expect((await emp('POST', `/api/users/${empId}/segments/${keyE}/release`)).status).toBe(403);
  });

  it('admin approve locks it: the approvedAt reaches the employee with the money still stripped', async () => {
    expect((await admin('POST', `/api/users/${empId}/segments/${keyE}/approve`)).status).toBe(200);
    const seg = (await empCommits()).find((c) => c.key === keyE);
    expect(typeof seg.approvedAt).toBe('string'); // lock state reaches the employee
    expect(Number.isNaN(Date.parse(seg.approvedAt))).toBe(false);
    expect(seg.snapshot).toEqual({}); // …but no money leaks
  });

  it('once approved the employee can no longer un-commit it (the drop is refused server-side)', async () => {
    // employee tries to un-commit by sending an empty ledger — returns 200…
    const un = await emp('PUT', '/api/state', { entries: [E], commits: [] });
    expect(un.status).toBe(200);
    // …but the segment is force-kept: it is STILL committed, still approved
    const seg = (await empCommits()).find((c) => c.key === keyE);
    expect(seg).toBeDefined();
    expect(typeof seg.approvedAt).toBe('string');
  });

  it('admin release hands it back: the employee can un-commit again', async () => {
    expect((await admin('POST', `/api/users/${empId}/segments/${keyE}/release`)).status).toBe(200);
    // after release, approvedAt is gone for the employee (a released segment is un-lockable)
    const relSeg = (await empCommits()).find((c) => c.key === keyE);
    expect(relSeg.approvedAt).toBeUndefined();
    // now the un-commit sticks
    const un = await emp('PUT', '/api/state', { entries: [E], commits: [] });
    expect(un.status).toBe(200);
    expect((await empCommits()).some((c) => c.key === keyE)).toBe(false);
  });

  it('404s approve/release on an unknown user or an uncommitted segment', async () => {
    expect((await admin('POST', `/api/users/999999/segments/${keyE}/approve`)).status).toBe(404);
    expect((await admin('POST', `/api/users/${empId}/segments/2000-W01-2000-01/approve`)).status).toBe(404);
  });
});

// SDD-002 ruling 7 (PLAN-006): archive-not-delete + the never-referenced true-delete
// guard. Proven over HTTP: archived persists as an admin-only flag and still costs in the
// team report (history resolves forever); the server itself refuses to hard-delete a
// referenced project code or client id and allows an unreferenced one; archiving a client
// does not null its projects' clientId. A referenced-delete 200 taken as proof without
// re-reading the survivor is the fake evidence — every claim re-reads with GET.
//
// ## Verified red-green: 2026-07-24
describe('archive-not-delete + referenced-delete guard (SDD-002 ruling 7)', () => {
  const admin = session();
  const emp = session();
  const CL = 'r7-client';
  const PR_ARCH = 'R7-ARCH'; // archived but referenced by an entry — stays for history
  const PR_REF = 'R7-REF'; // referenced by an entry — hard-delete refused
  const PR_FREE = 'R7-FREE'; // never referenced — hard-delete allowed
  let empId;
  /** @param {string} id @param {string} code @param {string} date */
  const E = (id, code, date) => ({
    id,
    date,
    start: 540,
    end: 660,
    durMin: null,
    project: code,
    label: 'w',
    note: id,
    billable: true,
  });

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'r7@timeturtle.local',
      name: 'Ruling Seven',
      role: 'employee',
      password: 'r7pw',
    });
    await emp('POST', '/api/auth/login', { email: 'r7@timeturtle.local', password: 'r7pw' });
    empId = (await admin('GET', '/api/users')).json.users.find((u) => u.email === 'r7@timeturtle.local').id;
    // admin adds a rated client + three projects on it (rate rides the client, exact rounding)
    const st = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      clients: [...st.json.clients, { id: CL, name: 'R7 Client', rounding: 'exact', rate: 1000, archived: false }],
      projects: [
        ...st.json.projects,
        { code: PR_ARCH, name: 'Arch', clientId: CL, rate: null, billable: true, archived: false },
        { code: PR_REF, name: 'Ref', clientId: CL, rate: null, billable: true, archived: false },
        { code: PR_FREE, name: 'Free', clientId: CL, rate: null, billable: true, archived: false },
      ],
    });
    expect(put.status).toBe(200);
    // employee logs a 120-min billable hour against PR_ARCH and one against PR_REF (references them)
    await emp('PUT', '/api/state', { entries: [E('r7arch', PR_ARCH, '2026-09-07'), E('r7ref', PR_REF, '2026-09-08')] });
  });

  it('an employee PUT touching projects or clients is 403 (archived is admin-owned by construction)', async () => {
    const st = await emp('GET', '/api/state');
    const p = await emp('PUT', '/api/state', {
      projects: st.json.projects.map((proj) => (proj.code === PR_ARCH ? { ...proj, archived: true } : proj)),
    });
    expect(p.status).toBe(403);
    const c = await emp('PUT', '/api/state', {
      clients: st.json.clients.map((cl) => (cl.id === CL ? { ...cl, archived: true } : cl)),
    });
    expect(c.status).toBe(403);
  });

  it('admin archives a project: it persists archived:true AND the team report still counts its money', async () => {
    const st = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      projects: st.json.projects.map((p) => (p.code === PR_ARCH ? { ...p, archived: true } : p)),
    });
    expect(put.status).toBe(200);
    const back = await admin('GET', '/api/state');
    expect(back.json.projects.find((p) => p.code === PR_ARCH).archived).toBe(true);
    // the archived project's entry still resolves in the report over its own date (history forever)
    const rep = await admin('GET', '/api/reports/team?from=2026-09-07&to=2026-09-07');
    const row = rep.json.rows.find((r) => r.userId === empId && r.project === PR_ARCH);
    expect(row).toMatchObject({ min: 120, bill: 120, amount: 2000, entries: 1 }); // 120min @ 1000/h = 2000
  });

  it('the server REFUSES to hard-delete a project code an entry references — the code survives', async () => {
    const st = await admin('GET', '/api/state');
    const drop = await admin('PUT', '/api/state', { projects: st.json.projects.filter((p) => p.code !== PR_REF) });
    expect(drop.status).toBe(409);
    expect(drop.json.conflict).toBe(true);
    const back = await admin('GET', '/api/state');
    expect(back.json.projects.some((p) => p.code === PR_REF)).toBe(true); // rejected wholesale
  });

  it('the server ALLOWS hard-deleting a never-referenced project code', async () => {
    const st = await admin('GET', '/api/state');
    const drop = await admin('PUT', '/api/state', { projects: st.json.projects.filter((p) => p.code !== PR_FREE) });
    expect(drop.status).toBe(200);
    const back = await admin('GET', '/api/state');
    expect(back.json.projects.some((p) => p.code === PR_FREE)).toBe(false);
  });

  it('the server REFUSES to hard-delete a client id a project references', async () => {
    const st = await admin('GET', '/api/state');
    const drop = await admin('PUT', '/api/state', { clients: st.json.clients.filter((c) => c.id !== CL) });
    expect(drop.status).toBe(409);
    const back = await admin('GET', '/api/state');
    expect(back.json.clients.some((c) => c.id === CL)).toBe(true);
  });

  it('archiving a client leaves its projects’ clientId intact (does NOT null them)', async () => {
    const st = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      clients: st.json.clients.map((c) => (c.id === CL ? { ...c, archived: true } : c)),
    });
    expect(put.status).toBe(200);
    const back = await admin('GET', '/api/state');
    expect(back.json.clients.find((c) => c.id === CL).archived).toBe(true);
    // projects still point at CL — archiving nulls nothing (contrast the dropped removeClient path)
    expect(back.json.projects.find((p) => p.code === PR_ARCH).clientId).toBe(CL);
    expect(back.json.projects.find((p) => p.code === PR_REF).clientId).toBe(CL);
  });
});

// SDD-002 DC-005 (PLAN-006): the transactional, admin-only project-code rename that
// reconciles every user's entries + templates. Proven over HTTP with a SECOND user (B):
// a rename rewrites B's entry AND B's template old→new (the orphan is gone by
// construction), an employee cannot call it, and a collision / empty-target / unknown code
// is rejected. The endpoint returns a bare ok — it never leaks B's entry content.
//
// ## Verified red-green: 2026-07-24
describe('DC-005 server-reconciled project-code rename (SDD-002)', () => {
  const admin = session();
  const emp = session(); // user B — a SECOND user, to prove the cross-user reconcile
  const X = 'DC5-OLD';
  const Y = 'DC5-NEW';
  const EXISTING = 'DC5-TAKEN';
  let empId;

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'dc5@timeturtle.local',
      name: 'DC Five',
      role: 'employee',
      password: 'dc5pw',
    });
    await emp('POST', '/api/auth/login', { email: 'dc5@timeturtle.local', password: 'dc5pw' });
    empId = (await admin('GET', '/api/users')).json.users.find((u) => u.email === 'dc5@timeturtle.local').id;
    // admin adds project X plus a project on an already-taken code (for the collision test)
    const st = await admin('GET', '/api/state');
    await admin('PUT', '/api/state', {
      projects: [
        ...st.json.projects,
        { code: X, name: 'Old', clientId: null, rate: null, billable: true, archived: false },
        { code: EXISTING, name: 'Taken', clientId: null, rate: null, billable: true, archived: false },
      ],
    });
    // employee B logs an entry AND creates a template on X (the copy-at-birth references)
    await emp('PUT', '/api/state', {
      tasks: [{ id: 'dc5-tpl', label: 'B template', project: X }],
      entries: [
        {
          id: 'dc5-e',
          date: '2026-10-05',
          start: 540,
          end: 600,
          durMin: null,
          project: X,
          label: 'w',
          note: 'onX',
          billable: true,
        },
      ],
    });
  });

  it('an employee cannot rename a project code (403) and X is untouched', async () => {
    const r = await emp('POST', `/api/projects/${X}/rename`, { to: Y });
    expect(r.status).toBe(403);
    expect((await admin('GET', '/api/state')).json.projects.some((p) => p.code === X)).toBe(true);
  });

  it('rejects an empty target (400), a collision (409) and an unknown code (404) — X survives each', async () => {
    expect((await admin('POST', `/api/projects/${X}/rename`, { to: '' })).status).toBe(400);
    expect((await admin('POST', `/api/projects/${X}/rename`, {})).status).toBe(400);
    expect((await admin('POST', `/api/projects/${X}/rename`, { to: EXISTING })).status).toBe(409);
    expect((await admin('POST', `/api/projects/NOPE-CODE/rename`, { to: Y })).status).toBe(404);
    expect((await admin('GET', '/api/state')).json.projects.some((p) => p.code === X)).toBe(true);
  });

  it('admin rename X→Y reconciles the project row AND B’s entry AND B’s template, returning a bare ok', async () => {
    const r = await admin('POST', `/api/projects/${X}/rename`, { to: Y });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true }); // blind reconcile — no cross-user entry content leaked

    // the project row is renamed
    const st = await admin('GET', '/api/state');
    expect(st.json.projects.some((p) => p.code === Y)).toBe(true);
    expect(st.json.projects.some((p) => p.code === X)).toBe(false);

    // B's OWN entry AND template both moved old→new (the DC-005 cross-user reconcile)
    const bState = (await emp('GET', '/api/state')).json;
    expect(bState.entries.find((e) => e.id === 'dc5-e').project).toBe(Y);
    expect(bState.tasks.find((t) => t.id === 'dc5-tpl').project).toBe(Y);
  });
});

// SB-070: an entry id is the one caller-supplied string that reaches the mirror's `## commits`
// section, and that section is deliberately NOT escaped (see the commits serializer in
// shared/core.js). An id holding a `|` splits its own frozen-money row — `  - a|b | 1250 | 60 |
// 100` parses back to snapshot key `a` with rate NaN — so COMMITTED money is silently rewritten
// on a mirror restore. Terje ruled option 1: reject the id at the API boundary, server-side.
//
// Proven at the api rung: hostile ids actually go over HTTP and the rejection is asserted, and
// the store is re-read to prove the rejected PUT wrote nothing. Reading the guard proves nothing.
// The legitimate half matters just as much — a guard that rejects real machine-generated ids is
// worse than the bug — so the accepted cases are the shapes the app actually produces.
//
// ## Verified red-green: 2026-07-25
// break — widen ENTRY_ID_RE in server/src/index.js to /^[\s\S]*$/ → 'rejects the pipe',
//   'rejects every other out-of-charset shape' and the admin-path test all fail (400 → 200),
//   and the store-unchanged assertions fail with them.
describe('SB-070 entry-id charset guard', () => {
  const admin = session();
  const emp = session();
  const PROJ = 'SB70-PROJ'; // dedicated, rated, so the frozen snapshot below is predictable
  const DATE = '2026-09-07';
  const KEY = TT.segmentKey(DATE);
  // The ids the machine actually mints: nid() from TT.newEntry (`e<n>-<base36>`), a
  // segmentKey-shaped id, and a plain date-ish id. None of them leaves [A-Za-z0-9._-].
  const NID = TT.newEntry(DATE).id;
  const GOOD_IDS = [NID, KEY, '2026-09-07', 'e12-ms0nqlr8', 'a.b_c-D9'];
  const line = (id) => ({
    id,
    date: DATE,
    start: 540,
    end: 660,
    durMin: null,
    project: PROJ,
    label: 'work',
    note: 'sb70',
    billable: true,
  });
  let empId;
  const empEntries = async () => (await emp('GET', '/api/state')).json.entries;

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'sb70@timeturtle.local',
      name: 'Seven Zero',
      role: 'employee',
      password: 'sb70pw',
    });
    await emp('POST', '/api/auth/login', { email: 'sb70@timeturtle.local', password: 'sb70pw' });
    empId = (await admin('GET', '/api/users')).json.users.find((u) => u.email === 'sb70@timeturtle.local').id;
    const st = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      projects: [...st.json.projects, { code: PROJ, name: 'SB70', clientId: null, rate: 900, billable: true }],
    });
    expect(put.status).toBe(200);
  });

  it('accepts every id shape the app actually generates (nid, segment key, dotted/underscored)', async () => {
    // nid() is `e<counter>-<base36 timestamp>`; the guard must not touch it, or logging an
    // hour stops working. This is the assertion that keeps the guard from being worse than
    // the bug it closes.
    expect(NID).toMatch(/^e\d+-[a-z0-9]+$/);
    const put = await emp('PUT', '/api/state', { entries: GOOD_IDS.map(line) });
    expect(put.status).toBe(200);
    expect((await empEntries()).map((e) => e.id).sort()).toEqual([...GOOD_IDS].sort());
  });

  it('rejects the pipe (the SB-070 repro) with 400, and the rejected PUT writes NOTHING', async () => {
    const before = await empEntries();
    const put = await emp('PUT', '/api/state', { entries: [...GOOD_IDS.map(line), line('a|b')] });
    expect(put.status).toBe(400);
    expect(put.json.error).toContain('a|b');
    expect(put.json.error).toContain('invalid entry id');
    // the whole collection-replace was refused — the store is byte-identical, and the
    // hostile id is nowhere near the mirror
    expect(await empEntries()).toEqual(before);
  });

  it('rejects every other out-of-charset shape, and an absent/non-string id', async () => {
    const hostile = [
      'a|b', // the column delimiter — the money-losing one
      'a\\b', // the escape character
      'a b', // whitespace splits nothing but is not machine-generated either
      'a\nb', // a newline would forge a second snapshot row outright
      'e1[nb]', // the flag-marker syntax
      'e1#x',
      'æøå',
      '', // empty
    ];
    for (const id of hostile) {
      const put = await emp('PUT', '/api/state', { entries: [line(id)] });
      expect(`${JSON.stringify(id)} → ${put.status}`).toBe(`${JSON.stringify(id)} → 400`);
    }
    // a missing id, and an id that is not a string at all, are rejected on the same path
    expect((await emp('PUT', '/api/state', { entries: [{ ...line('x'), id: undefined }] })).status).toBe(400);
    expect((await emp('PUT', '/api/state', { entries: [{ ...line('x'), id: { toString: () => 'ok' } }] })).status).toBe(
      400,
    );
    // and the good state from the first test is still exactly what is stored
    expect((await empEntries()).map((e) => e.id).sort()).toEqual([...GOOD_IDS].sort());
  });

  it('the admin cross-user path rejects it too, and the target’s entries survive', async () => {
    // PUT /api/users/:id/entries re-freezes commit snapshots as well, so it is the same hole.
    const before = (await admin('GET', `/api/users/${empId}/timesheet`)).json.entries;
    const put = await admin('PUT', `/api/users/${empId}/entries`, { entries: [...before, line('adm|hack')] });
    expect(put.status).toBe(400);
    expect(put.json.error).toContain('adm|hack');
    expect((await admin('GET', `/api/users/${empId}/timesheet`)).json.entries).toEqual(before);
  });

  it('with only clean ids surviving the guard, the frozen money round-trips off the mirror on disk', async () => {
    // The point of the guard, end to end: commit the segment, then parse the bytes the server
    // actually wrote. Every snapshot key must come back as the id that went in, with numeric
    // money — which is precisely what a piped id destroyed (key truncated, rate NaN).
    const commit = await emp('PUT', '/api/state', { entries: GOOD_IDS.map(line), commits: [{ key: KEY }] });
    expect(commit.status).toBe(200);

    const mdDir = join(DATA_DIR, 'markdown');
    const text = readdirSync(mdDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(mdDir, f), 'utf8'))
      .find((t) => t.includes('sb70'));
    expect(text).toBeDefined();
    const seg = TT.parseMd(text).commits.find((c) => c.key === KEY);
    expect(seg).toBeDefined();
    // 120 min on a rate-900 exact project → rate 900 | billMin 120 | amount 1800, per id
    expect(Object.keys(seg.snapshot).sort()).toEqual([...GOOD_IDS].sort());
    for (const id of GOOD_IDS) {
      expect(`${id} → ${JSON.stringify(seg.snapshot[id])}`).toBe(`${id} → {"rate":900,"billMin":120,"amount":1800}`);
    }
  });
});

// SB-074: the OTHER half of SB-070, and wider — an entry id is machine-minted by nid(), but the
// commit SEGMENT KEY is taken verbatim from the request body. A key holding a `|` splits its own
// segment HEADER in the unescaped `## commits` section: `- 2026-W30-2026-07|x | <ts>` parses back
// as key `2026-W30-2026-07` with committedAt `x`, so two segments share one key and
// `TT.commitSnapshot`'s `commits.find(...)` takes the first — the empty one. Frozen money gone on
// a mirror restore. Fixed the SB-070 way: reject at the API boundary before anything writes.
//
// Three guards, and the evidence is honest about what each one is worth (measured on main @
// ffdc809, over real HTTP, before the fix):
//   • segment key  — a LIVE hole. `PUT {commits:[{key:'…|x'},{key:'…'}]}` returned 200, both keys
//     landed in the store, and the mirror bytes on disk parsed back to two identical keys with
//     committedAt 'x' → commitSnapshot null. This is the guard that saves the money.
//   • committedAt  — defence in depth, NOT a live hole: reconcileCommits already discards a
//     client committedAt (server-stamps a new key, keeps a stored key verbatim), so the hostile
//     value never reached the store. The guard stops a future refactor from re-opening it.
//   • duplicate key — defence in depth too: reconcileCommits already dedupes incoming keys
//     first-seen-wins. The duplicates that lose money are MANUFACTURED downstream by the split
//     header, which the key guard prevents.
//
// Proven at the api rung (hostile payloads over real HTTP, store re-read after each rejection)
// plus the end-to-end that actually matters: the frozen figures are read back out of the mirror
// BYTES on disk, not out of memory. The accepting half matters as much as the rejecting half —
// a guard that rejects real TT.segmentKey output is worse than the bug — so the accepted keys are
// generated by TT.segmentKey itself, straddling weeks included, and committedAt is the exact ISO
// instant the client's commitSegment sends (SB-070's `[A-Za-z0-9._-]` charset would reject every
// one of those: an ISO timestamp contains `:`).
//
// ## Verified red-green: 2026-07-25
// break — `isSegmentKey` in server/src/index.js → `return typeof key === 'string'`: 'rejects the
//   SB-074 repro' and 'rejects every other hostile segment key' fail (400 → 200) and the
//   store-unchanged assertion fails with them.
// break — drop the `!isIsoInstant(at)` branch from commitLedgerError: 'rejects a hostile
//   committedAt' fails (400 → 200).
// break — drop the `seen.has(key)` branch from commitLedgerError: 'rejects a duplicate segment
//   key' fails (400 → 200).
describe('SB-074 commit segment key / committedAt guard', () => {
  const admin = session();
  const emp = session();
  const PROJ = 'SB74-PROJ'; // dedicated, rated, so the frozen snapshot below is predictable
  const DATE = '2026-07-22'; // the ticket's repro date
  const KEY = TT.segmentKey(DATE);
  const ID = 'e1-abc';
  // Real keys, generated by TT.segmentKey — never typed out. weekSegments returns BOTH halves of
  // a month-straddling week, and the 2025-12-31 week straddles the year too (ISO week-year 2026
  // over calendar months 2025-12 and 2026-01) — the shapes a naive regex is most likely to break.
  const STRADDLE = TT.weekSegments('2025-12-31');
  const GOOD_KEYS = [KEY, ...STRADDLE.map((s) => s.key)];
  const line = { id: ID, date: DATE, start: 540, end: 660, durMin: null, project: PROJ, label: 'w', note: 'sb74', billable: true }; // prettier-ignore
  let empId;
  const empCommits = async () => (await emp('GET', '/api/state')).json.commits;
  // The admin timesheet carries the FULL ledger (money included) — an employee GET strips the
  // snapshot, so a store-unchanged assertion made there could not see a snapshot being rewritten.
  const fullLedger = async () => (await admin('GET', `/api/users/${empId}/timesheet`)).json.commits;

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'sb74@timeturtle.local',
      name: 'Seven Four',
      role: 'employee',
      password: 'sb74pw',
    });
    await emp('POST', '/api/auth/login', { email: 'sb74@timeturtle.local', password: 'sb74pw' });
    empId = (await admin('GET', '/api/users')).json.users.find((u) => u.email === 'sb74@timeturtle.local').id;
    const st = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      projects: [...st.json.projects, { code: PROJ, name: 'SB74', clientId: null, rate: 900, billable: true }],
    });
    expect(put.status).toBe(200);
  });

  it('accepts every segment key TT.segmentKey produces, straddling weeks included', async () => {
    // The setup is asserted, not assumed: the 2025-12-31 week really does split into two segments
    // across a year AND a month boundary. If TT.segmentKey's grammar ever changes, this test is
    // the alarm — the guard is derived from that function, so it would start over-rejecting here.
    expect(STRADDLE.map((s) => s.key)).toEqual(['2026-W01-2025-12', '2026-W01-2026-01']);
    expect(KEY).toBe('2026-W30-2026-07');
    // committedAt is exactly what the client's commitSegment sends: new Date().toISOString().
    // SB-070's `[A-Za-z0-9._-]` charset would reject it outright — ISO timestamps carry `:`.
    const at = new Date().toISOString();
    const put = await emp('PUT', '/api/state', {
      entries: [line],
      commits: GOOD_KEYS.map((key) => ({ key, committedAt: at, snapshot: {} })),
    });
    expect(put.status).toBe(200);
    expect((await empCommits()).map((c) => c.key).sort()).toEqual([...GOOD_KEYS].sort());
    // and a bare `{ key }` with committedAt absent is still fine — the server stamps it
    const bare = await emp('PUT', '/api/state', { entries: [line], commits: GOOD_KEYS.map((key) => ({ key })) });
    expect(bare.status).toBe(200);
    expect((await empCommits()).every((c) => typeof c.committedAt === 'string' && c.committedAt)).toBe(true);
  });

  it('rejects the SB-074 repro with 400, and the rejected PUT writes NOTHING', async () => {
    const before = await fullLedger();
    const put = await emp('PUT', '/api/state', {
      entries: [line],
      commits: [
        { key: KEY + '|x', committedAt: '2026-07-25T10:00:00.000Z', snapshot: {} },
        { key: KEY, committedAt: '2026-07-25T10:00:00.000Z', snapshot: {} },
      ],
    });
    expect(put.status).toBe(400);
    expect(put.json.error).toContain(KEY + '|x');
    expect(put.json.error).toContain('invalid commit segment key');
    // the whole collection-replace was refused — the ledger (money included) is untouched, and
    // the hostile key never got near the serializer
    expect(await fullLedger()).toEqual(before);
  });

  it('rejects every other hostile segment key, including well-formed-but-impossible ones', async () => {
    const before = await fullLedger();
    const hostile = [
      KEY + '|x', // the repro — the header delimiter
      KEY + ' | forged', // a whole forged committedAt column
      KEY + ' | ' + new Date().toISOString() + ' | approved:2020-01-01T00:00:00.000Z', // a forged LOCK
      KEY + '\n- ' + KEY + ' | 2026-07-25T10:00:00.000Z', // a newline forges a second header outright
      '2026-W99-2026-07', // right shape, no calendar date produces it
      '2026-W01-2026-07', // a real ISO week, but W01 2026 never touches July
      '2026-W30-2026-13', // month 13
      '2026-w30-2026-07', // wrong case
      '2026-W3-2026-07', // unpadded week
      ' ' + KEY, // leading space
      KEY + ' ', // trailing space (the mirror trims cells — SB-072)
      '', // empty
    ];
    for (const key of hostile) {
      const put = await emp('PUT', '/api/state', { entries: [line], commits: [{ key }] });
      expect(`${JSON.stringify(key)} → ${put.status}`).toBe(`${JSON.stringify(key)} → 400`);
    }
    // a missing key, and a key that is not a string at all, are rejected on the same path
    expect((await emp('PUT', '/api/state', { entries: [line], commits: [{ snapshot: {} }] })).status).toBe(400);
    expect((await emp('PUT', '/api/state', { entries: [line], commits: [{ key: 20260730 }] })).status).toBe(400);
    expect((await emp('PUT', '/api/state', { entries: [line], commits: [null] })).status).toBe(400);
    expect(await fullLedger()).toEqual(before);
  });

  it('rejects a hostile committedAt — the field that carries the lock tokens', async () => {
    const before = await fullLedger();
    const hostile = [
      'x | approved:2020-01-01T00:00:00.000Z', // forges the SB-025 approval lock
      'x', // what the split header produced in the repro
      '2026-07-25T10:00:00.000Z\n- ' + KEY + ' | 2026-07-25T10:00:00.000Z',
      'not-a-date',
      '2026-07-25T10:00:00Z', // a valid ISO 8601 instant, but NOT the canonical form either
      // emitter produces (new Date().toISOString() always carries .sss) — rejected on purpose
      '', // empty is not absent: absent is stamped, empty would emit a blank column
      1753437600000, // not a string
    ];
    for (const committedAt of hostile) {
      const put = await emp('PUT', '/api/state', { entries: [line], commits: [{ key: KEY, committedAt }] });
      expect(`${JSON.stringify(committedAt)} → ${put.status}`).toBe(`${JSON.stringify(committedAt)} → 400`);
      expect(put.json.error).toContain('committedAt');
    }
    expect(await fullLedger()).toEqual(before);
  });

  it('rejects a duplicate segment key — one key may name only one segment', async () => {
    const before = await fullLedger();
    const at = new Date().toISOString();
    const put = await emp('PUT', '/api/state', {
      entries: [line],
      commits: [
        { key: KEY, committedAt: at, snapshot: {} },
        { key: KEY, committedAt: at, snapshot: {} },
      ],
    });
    expect(put.status).toBe(400);
    expect(put.json.error).toContain('duplicate commit segment key');
    expect(put.json.error).toContain(KEY);
    expect(await fullLedger()).toEqual(before);
  });

  it('the frozen money survives a round-trip through the mirror BYTES on disk', async () => {
    // The point of the guard, end to end, in the order it happens in the wild: commit for real,
    // then take the hostile PUT, then read what the server actually wrote to disk. Before the fix
    // that hostile PUT landed, its `|` split the header into two segments sharing KEY, and
    // commitSnapshot took the first (empty) one — this read returned null and the money was gone.
    const at = new Date().toISOString();
    const commit = await emp('PUT', '/api/state', {
      entries: [line],
      commits: GOOD_KEYS.map((key) => ({ key, committedAt: at, snapshot: {} })),
    });
    expect(commit.status).toBe(200);
    const attack = await emp('PUT', '/api/state', {
      entries: [line],
      commits: [{ key: KEY + '|x', committedAt: at, snapshot: {} }, ...GOOD_KEYS.map((key) => ({ key }))],
    });
    expect(attack.status).toBe(400);

    const text = readdirSync(join(DATA_DIR, 'markdown'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(DATA_DIR, 'markdown', f), 'utf8'))
      .find((t) => t.includes('sb74'));
    expect(text).toBeDefined();
    // exactly one header per committed segment, and no key appears twice
    const headers = text
      .slice(text.indexOf('## commits'))
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(headers).toHaveLength(GOOD_KEYS.length);
    const parsed = TT.parseMd(text);
    expect(parsed.commits.map((c) => c.key).sort()).toEqual([...GOOD_KEYS].sort());
    expect(new Set(parsed.commits.map((c) => c.key)).size).toBe(GOOD_KEYS.length);
    // every committedAt came back whole — the split header truncated one to 'x'
    for (const c of parsed.commits) expect(new Date(c.committedAt).toISOString()).toBe(c.committedAt);
    // and the money is still there: 120 min on a rate-900 exact project → 900 | 120 | 1800
    const state = { ...parsed, commits: parsed.commits };
    expect(JSON.stringify(TT.commitSnapshot(state, { id: ID, date: DATE }))).toBe(
      '{"rate":900,"billMin":120,"amount":1800}',
    );
  });
});

// SB-072: the mirror parser splits a row on `|` and trims every cell it produces
// (`splitUnescaped(s, '|', true)`, shared/core.js), so it cannot tell format padding from typed
// content — a stored note `'trailing space '` came back `'trailing space'` on a mirror restore,
// and Settings → Markdown backend makes that restore a one-action UI path. Terje's re-ruling:
// make the DATA fit the format instead of escaping the edges — trim `entry.note` and
// `client.name` on the way in, server-side, so the DB never holds a value the mirror cannot
// round-trip. Server-side is the point: the claim is a data-integrity guarantee, and a
// client-side trim is bypassable by exactly the raw PUTs below.
//
// Proven at the api rung — every assertion below reads what the server STORED (a fresh GET, or
// the mirror bytes the server itself wrote to disk), never the payload that was sent. The
// interior-whitespace control is load-bearing: `'a  b'` is what a careless trim/collapse breaks,
// and the format genuinely carries it.
//
// ## Verified red-green: 2026-07-25
// break — drop `.trim()` from String(entry.note ?? '') and String(client.name) in
//   server/src/db.js putEntries/putClients → 'stores entry.note trimmed', 'stores client.name
//   trimmed', both round-trip tests and the mirror-on-disk test fail (4 of 5 in this block; the
//   interior-whitespace control stays green, as it must).
describe('SB-072 edge whitespace is trimmed at the write edge', () => {
  const admin = session();
  const emp = session();
  const DATE = '2026-09-14';
  // id → [what is PUT, what must be STORED]. The last two are the control: interior
  // whitespace is representable in the mirror and must survive untouched.
  const NOTES = {
    'sb72-lead': [' leading', 'leading'],
    'sb72-trail': ['trailing space ', 'trailing space'],
    'sb72-both': ['  padded  ', 'padded'],
    'sb72-tabnl': ['\t\n mixed \n\t', 'mixed'],
    'sb72-blank': ['   ', ''],
    'sb72-interior': ['a  b', 'a  b'],
    'sb72-interior-edge': [' a  b ', 'a  b'],
  };
  const CLIENT_PAD = 'SB72-PAD';
  const CLIENT_INTERIOR = 'SB72-INT';
  const entry = (id, note) => ({
    id,
    date: DATE,
    start: 540,
    end: 660,
    durMin: null,
    project: null,
    label: 'sb72 work',
    note,
    billable: false,
  });
  const stored = async () => (await emp('GET', '/api/state')).json;

  beforeAll(async () => {
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    await admin('POST', '/api/users', {
      email: 'sb72@timeturtle.local',
      name: 'Seven Two',
      role: 'employee',
      password: 'sb72pw',
    });
    await emp('POST', '/api/auth/login', { email: 'sb72@timeturtle.local', password: 'sb72pw' });
    // Raw PUTs — no client code runs in this test, which is the whole point of proving the
    // guarantee here rather than in the UI. Existing clients are carried forward (ruling 7).
    const st = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', {
      clients: [
        ...st.json.clients,
        { id: CLIENT_PAD, name: '  Padded Client  ', rounding: 'exact', rate: null },
        { id: CLIENT_INTERIOR, name: 'Two  Spaces', rounding: 'exact', rate: null },
      ],
    });
    expect(put.status).toBe(200);
    const entries = await emp('PUT', '/api/state', {
      entries: Object.entries(NOTES).map(([id, [sent]]) => entry(id, sent)),
    });
    expect(entries.status).toBe(200);
  });

  it('stores entry.note trimmed — the GET reflects the DB, not the payload', async () => {
    const byId = Object.fromEntries((await stored()).entries.map((e) => [e.id, e.note]));
    for (const [id, [sent, want]] of Object.entries(NOTES)) {
      expect(`${id} ${JSON.stringify(sent)} → ${JSON.stringify(byId[id])}`).toBe(
        `${id} ${JSON.stringify(sent)} → ${JSON.stringify(want)}`,
      );
    }
  });

  it('stores client.name trimmed, and leaves interior whitespace alone', async () => {
    const byId = Object.fromEntries((await stored()).clients.map((c) => [c.id, c.name]));
    expect(byId[CLIENT_PAD]).toBe('Padded Client');
    expect(byId[CLIENT_INTERIOR]).toBe('Two  Spaces');
  });

  it('an interior-whitespace note is not collapsed or trimmed (the control)', async () => {
    // This is what a careless trim breaks, and what the mirror format genuinely does carry.
    const byId = Object.fromEntries((await stored()).entries.map((e) => [e.id, e.note]));
    expect(byId['sb72-interior']).toBe('a  b');
    expect(byId['sb72-interior']).not.toBe('a b');
  });

  // An entry id is NOT carried in a day row (only the `## commits` snapshot keys are), so a
  // parsed entry gets a fresh id — these compare the notes in file order, which serializeMd
  // preserves, rather than by id.
  const notesOn = (state) => state.entries.filter((e) => e.date === DATE).map((e) => e.note);
  const WANT = Object.values(NOTES).map(([, want]) => want);

  it('serialize→parse of the stored state is now EXACT for every note and both names', async () => {
    const state = await stored();
    const back = TT.parseMd(TT.serializeMd(state));
    // exact means exact: the notes that came out of the DB come back unchanged, in order
    expect(notesOn(back)).toEqual(notesOn(state));
    expect([...notesOn(back)].sort()).toEqual([...WANT].sort());
    const nameById = Object.fromEntries(back.clients.map((c) => [c.id, c.name]));
    expect(nameById[CLIENT_PAD]).toBe('Padded Client');
    expect(nameById[CLIENT_INTERIOR]).toBe('Two  Spaces');
  });

  it('the mirror the server wrote to disk round-trips these values', async () => {
    // The end-to-end shape of the bug: the file Settings → Markdown backend hands the user,
    // written by the server itself from the DB. Before the trim, ' leading' went in and
    // 'leading' came back out of here.
    const text = readFileSync(join(DATA_DIR, 'markdown', 'timesheet-seven-two.md'), 'utf8');
    const back = TT.parseMd(text);
    expect([...notesOn(back)].sort()).toEqual([...WANT].sort());
    const nameById = Object.fromEntries(back.clients.map((c) => [c.id, c.name]));
    expect(nameById[CLIENT_PAD]).toBe('Padded Client');
    expect(nameById[CLIENT_INTERIOR]).toBe('Two  Spaces');
    // and re-serializing what came off disk is a fixed point — no residual drift
    expect(TT.serializeMd(back)).toBe(text);
  });
});

// DC-001: PUT /api/state used to be last-write-wins. A `version` in the body makes
// the write conditional. These run last — they replace the catalog wholesale.
// SDD-002 ruling 7 (PLAN-006): a wholesale replace may no longer DROP a referenced
// client, so these carry the existing clients forward and add/replace a marker client;
// the concurrency assertions (stale write 409s, winner lands, unconditional write lands)
// are unchanged — only the incidentally-illegal deletion of seeded clients is removed.
//
// ## Verified red-green: 2026-07-23
// break A — drop the catalog compare in index.js → 'a stale catalog write is rejected' fails
// break B — point entriesScope at 'catalog' in db.js → "does not conflict an employee's entry save" fails
describe('optimistic concurrency (DC-001)', () => {
  const client = (id, name) => ({ id, name, rounding: 'exact', rate: 1 });
  const entry = (id, note) => ({
    id,
    date: '2026-02-01',
    start: 540,
    end: 600,
    durMin: null,
    task: null,
    note,
    billable: true,
  });

  async function loginAs(email, password) {
    const req = session();
    const r = await req('POST', '/api/auth/login', { email, password });
    expect(r.status).toBe(200);
    return req;
  }
  const admin = () => loginAs('admin@timeturtle.local', 'testpw');
  const employee = () => loginAs('emp@timeturtle.local', 'emppw');

  it('GET /api/state carries catalog and entries versions', async () => {
    const state = await (await admin())('GET', '/api/state');
    expect(typeof state.json.version.catalog).toBe('number');
    expect(typeof state.json.version.entries).toBe('number');
  });

  it('a stale catalog write is rejected with 409 and the winner survives', async () => {
    const first = await admin();
    const second = await admin();
    const before = (await first('GET', '/api/state')).json;
    const staleState = (await second('GET', '/api/state')).json;
    const stale = staleState.version;

    // additive (ruling 7): carry existing clients forward, add the marker
    const won = await first('PUT', '/api/state', {
      clients: [...before.clients, client('winner', 'Winner')],
      version: before.version,
    });
    expect(won.status).toBe(200);

    // second still holds the version it loaded — the write must not land
    const lost = await second('PUT', '/api/state', {
      clients: [...staleState.clients, client('loser', 'Loser')],
      version: stale,
    });
    expect(lost.status).toBe(409);
    expect(lost.json.conflict).toBe(true);

    const after = (await first('GET', '/api/state')).json;
    expect(after.clients.some((c) => c.id === 'winner')).toBe(true); // winner landed
    expect(after.clients.some((c) => c.id === 'loser')).toBe(false); // loser's stale write did not

    // the 409 hands back the current version, so a retry goes through
    const retry = await second('PUT', '/api/state', {
      clients: [...after.clients, client('retry', 'Retried')],
      version: lost.json.version,
    });
    expect(retry.status).toBe(200);
    expect((await second('GET', '/api/state')).json.clients.some((c) => c.id === 'retry')).toBe(true);
  });

  it('the PUT response carries the new version, so a session saves twice without reloading', async () => {
    const req = await admin();
    const start = (await req('GET', '/api/state')).json;
    let version = start.version;
    let clients = start.clients;
    for (const name of ['One', 'Two', 'Three']) {
      clients = [...clients.filter((c) => c.id !== 'seq'), client('seq', name)];
      const put = await req('PUT', '/api/state', { clients, version });
      expect(put.status).toBe(200);
      version = put.json.version;
    }
    expect((await req('GET', '/api/state')).json.clients.find((c) => c.id === 'seq').name).toBe('Three');
  });

  it("an admin's catalog write does not conflict an employee's entry save", async () => {
    const emp = await employee();
    const empVersion = (await emp('GET', '/api/state')).json.version;

    const adm = await admin();
    const admState = (await adm('GET', '/api/state')).json;
    const bump = await adm('PUT', '/api/state', {
      clients: [...admState.clients, client('shared', 'Shared')],
      version: admState.version,
    });
    expect(bump.status).toBe(200);

    // the employee's catalog version is now stale, but entries are scoped per user
    const put = await emp('PUT', '/api/state', { entries: [entry('e1', 'kept')], version: empVersion });
    expect(put.status).toBe(200);
    expect((await emp('GET', '/api/state')).json.entries.map((e) => e.note)).toEqual(['kept']);
  });

  it("an employee's own stale entry write is rejected", async () => {
    const tabOne = await employee();
    const tabTwo = await employee();
    const stale = (await tabTwo('GET', '/api/state')).json.version;

    const won = await tabOne('PUT', '/api/state', {
      entries: [entry('e2', 'from tab one')],
      version: (await tabOne('GET', '/api/state')).json.version,
    });
    expect(won.status).toBe(200);

    const lost = await tabTwo('PUT', '/api/state', { entries: [entry('e3', 'from tab two')], version: stale });
    expect(lost.status).toBe(409);
    expect((await tabOne('GET', '/api/state')).json.entries.map((e) => e.note)).toEqual(['from tab one']);
  });

  it('a write with no version is unconditional (If-Match semantics)', async () => {
    const first = await admin();
    const second = await admin();
    const secondState = (await second('GET', '/api/state')).json;
    const stale = secondState.version;
    const firstState = (await first('GET', '/api/state')).json;
    await first('PUT', '/api/state', {
      clients: [...firstState.clients, client('a', 'A')],
      version: firstState.version,
    });

    // same stale version, but omitted — the write lands (dropping the unreferenced 'a' is legal)
    expect(stale).toBeDefined();
    const put = await second('PUT', '/api/state', { clients: [...secondState.clients, client('b', 'B')] });
    expect(put.status).toBe(200);
    expect((await second('GET', '/api/state')).json.clients.some((c) => c.id === 'b')).toBe(true);
  });
});
