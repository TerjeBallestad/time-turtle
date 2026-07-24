// DC-002: TT_MD_DIR_LOCK freezes the markdown mirror at the env path. Two REAL
// servers are spawned — one locked, one not — so "the lock is what blocks it" is
// proven by contrast rather than asserted about the locked server alone.
//
// ## Verified red-green: 2026-07-23
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './util.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server', 'src', 'index.js');

const LOCKED_DATA = mkdtempSync(join(tmpdir(), 'tt-lock-'));
const OPEN_DATA = mkdtempSync(join(tmpdir(), 'tt-open-'));
// Where an admin would try to re-point the mirror. Under the lock nothing may appear here.
const ELSEWHERE = mkdtempSync(join(tmpdir(), 'tt-elsewhere-'));

const children = [];

// A cookie jar bound to one logical session against one server.
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

function stopServer(child) {
  return new Promise((ok) => {
    child.on('exit', ok);
    child.kill('SIGKILL');
  });
}

async function adminOn(port) {
  const admin = session(port);
  const login = await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
  expect(login.status).toBe(200);
  return admin;
}

let LOCKED_PORT;
let OPEN_PORT;

beforeAll(async () => {
  const [locked, open] = await Promise.all([
    startServer({ TT_DATA_DIR: LOCKED_DATA, TT_MD_DIR_LOCK: '1' }),
    startServer({ TT_DATA_DIR: OPEN_DATA }),
  ]);
  LOCKED_PORT = locked.port;
  OPEN_PORT = open.port;
}, 30000);

afterAll(() => {
  for (const child of children) if (!child.killed) child.kill('SIGKILL');
});

describe('TT_MD_DIR_LOCK', () => {
  it('without the lock, an admin can re-point the mirror at any path', async () => {
    const admin = await adminOn(OPEN_PORT);
    const state = await admin('GET', '/api/state');
    expect(state.json.mdDirLocked).toBeFalsy();
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, mdDir: ELSEWHERE } });
    expect(put.status).toBe(200);
    // the mirror really moved — this is the capability the lock exists to remove
    expect(readdirSync(ELSEWHERE).filter((f) => f.endsWith('.md')).length).toBeGreaterThan(0);
  });

  it('with the lock, changing mdDir is rejected with 403', async () => {
    const admin = await adminOn(LOCKED_PORT);
    const state = await admin('GET', '/api/state');
    const forbidden = join(ELSEWHERE, 'locked-attempt');
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, mdDir: forbidden } });
    expect(put.status).toBe(403);
    expect(put.json.error).toMatch(/TT_MD_DIR_LOCK/);
    // and the setting did not sneak in, nor did the directory get created
    const after = await admin('GET', '/api/state');
    expect(after.json.settings.mdDir).toBe('');
    expect(existsSync(forbidden)).toBe(false);
  });

  it('with the lock, other settings still save (mdDir rides along unchanged)', async () => {
    const admin = await adminOn(LOCKED_PORT);
    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, currency: 'EUR' } });
    expect(put.status).toBe(200);
    const after = await admin('GET', '/api/state');
    expect(after.json.settings.currency).toBe('EUR');
  });

  it('with the lock, /api/state reports mdDirLocked and the mirror stays under TT_MD_DIR', async () => {
    const admin = await adminOn(LOCKED_PORT);
    const state = await admin('GET', '/api/state');
    expect(state.json.mdDirLocked).toBe(true);
    const mdDir = join(LOCKED_DATA, 'markdown');
    expect(existsSync(mdDir)).toBe(true);
    expect(readdirSync(mdDir).filter((f) => f.endsWith('.md')).length).toBeGreaterThan(0);
  });

  // The lock is usually switched on *after* someone already pointed the mirror
  // somewhere: rejecting future writes is not enough, the stored value has to stop
  // being honoured too. Same data dir, restarted with the lock set.
  it('the lock overrides an mdDir already stored in the database', async () => {
    const data = mkdtempSync(join(tmpdir(), 'tt-stale-'));
    const stale = mkdtempSync(join(tmpdir(), 'tt-stale-target-'));

    const before = await startServer({ TT_DATA_DIR: data });
    const openAdmin = await adminOn(before.port);
    const state = await openAdmin('GET', '/api/state');
    expect((await openAdmin('PUT', '/api/state', { settings: { ...state.json.settings, mdDir: stale } })).status).toBe(
      200,
    );
    expect(readdirSync(stale).filter((f) => f.endsWith('.md')).length).toBeGreaterThan(0);
    const staleCountAtLock = readdirSync(stale).length;
    await stopServer(before.child);

    const after = await startServer({ TT_DATA_DIR: data, TT_MD_DIR_LOCK: '1' });
    const lockedAdmin = await adminOn(after.port);
    const lockedState = await lockedAdmin('GET', '/api/state');
    expect(lockedState.json.mdDirLocked).toBe(true);
    const put = await lockedAdmin('PUT', '/api/state', { entries: lockedState.json.entries });
    expect(put.status).toBe(200);
    // the mirror came home to TT_MD_DIR and the stale target gained nothing
    expect(put.json.mirror.startsWith(join(data, 'markdown'))).toBe(true);
    expect(readdirSync(stale).length).toBe(staleCountAtLock);
  }, 30000);
});
