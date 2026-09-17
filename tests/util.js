// Shared test helpers.
//
// freePort() takes a port from the OS (listen on 0, read the assigned port, close)
// rather than guessing one. A hardcoded port is a latent flake: any leftover dev
// server on it answers our readiness probes, the real child dies with EADDRINUSE,
// and the suite fails for the wrong reason (a misleading 401-instead-of-200). See
// SB-012.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

// ---- the spawn-a-real-server harness ----
//
// Real child processes, not an in-process app: the things being proven — an env var winning, a
// bind, a first run — are properties of a process starting up, and none of them exist inside a
// module import.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server', 'src', 'index.js');

/** Every child this module spawned, so a suite can kill them all in afterAll. */
export const children = [];

/** A cookie jar bound to one logical session against one server. */
export function session(port) {
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

/**
 * Spawn a server on a free port and wait for it to answer. `output()` is everything the server
 * printed to stdout so far — the buffer also keeps the pipe drained.
 * @returns {Promise<{port: number, child: any, output: () => string}>}
 */
export async function startServer(env) {
  const port = await freePort();
  const child = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(port), TT_SEED_DEMO: '1', TT_ADMIN_PASSWORD: 'testpw', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
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
      if (res.status) return { port, child, output: () => out };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${port} did not become ready`);
}

export function stopServer(child) {
  return new Promise((ok) => {
    child.on('exit', ok);
    child.kill('SIGKILL');
  });
}

export function stopAllServers() {
  for (const child of children) if (!child.killed) child.kill('SIGKILL');
}

/** Log in as the seeded admin and return its session. */
export async function adminOn(port) {
  const admin = session(port);
  const login = await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
  expect(login.status).toBe(200);
  return admin;
}
