// Shared test helpers.
//
// freePort() takes a port from the OS (listen on 0, read the assigned port, close)
// rather than guessing one. A hardcoded port is a latent flake: any leftover dev
// server on it answers our readiness probes, the real child dies with EADDRINUSE,
// and the suite fails for the wrong reason (a misleading 401-instead-of-200). See
// SB-012 — this helper started life inside md-dir-lock.test.js.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import TT from '../shared/core.js';

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

// ---- SB-056: the spawn-a-real-server harness ----
//
// md-dir-lock.test.js and mirror-guard.test.js each carry their own copy of the three
// functions below. Those two files are the pin on the company deployment and PLAN-010 is
// forbidden to touch them, so this is the SHARED copy the new files use rather than a third
// and a fourth. If those two are ever edited for another reason, fold them in here.
//
// Real child processes, not an in-process app: the things being proven — an env var winning,
// a lock beating a stored setting, a server REFUSING TO BOOT — are properties of a process
// starting up, and none of them exist inside a module import.

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
 * Spawn a server on a free port and wait for it to answer.
 *
 * `output()` IS THE BOOT BANNER (PLAN-013 / SB-115). `runServerUntilExit` below has always
 * captured stdout, but only for a process that EXITS — which left the boot lines of a server that
 * STARTS unobservable, and the stranding lines DD-018 puts in the banner are exactly that. The
 * accumulating buffer also means stdout is now drained rather than left to fill its pipe.
 *
 * POLL IT, never read it once: `startServer` resolves as soon as `/api/me` answers, and that can
 * beat lines printed from the `app.listen` callback. Lines printed at module top level — which is
 * where the shape banner lives — are already there, but a caller cannot tell which is which.
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

/**
 * Spawn a server that is EXPECTED TO EXIT, and report how. The boot refusals (an unknown
 * TT_SHAPE; `personal` against a multi-user data dir) are the one class of guard that cannot be
 * observed over HTTP — there is no server to ask — so the evidence is the exit code and what
 * the process said on its way out.
 * @returns {Promise<{ code: number | null, output: string }>} stdout and stderr, concatenated
 */
export async function runServerUntilExit(env, timeoutMs = 15000) {
  const port = await freePort();
  const child = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(port), TT_SEED_DEMO: '1', TT_ADMIN_PASSWORD: 'testpw', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Registered like any other child. The timeout path SIGKILLs, so the normal case is bounded —
  // but if the vitest worker is torn down before the timer fires (a sibling test failing the
  // file, a pool force-exit) an unregistered child orphans holding its port.
  children.push(child);
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  return await new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`server did not exit within ${timeoutMs}ms — it started instead. Output:\n${output}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      ok({ code, output });
    });
  });
}

/** Log in as the seeded admin and return its session. */
export async function adminOn(port) {
  const admin = session(port);
  const login = await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
  expect(login.status).toBe(200);
  return admin;
}

/**
 * A DAY THIS INSTALL'S FREEZE CANNOT CLAIM — for suites that need to log an hour and do not
 * care which day it lands on (SB-161).
 *
 * The three suites this was extracted from each wrote a hardcoded `'2026-07-26'`, which was
 * `todayStr()` on the day it was typed and went pre-cutover the next morning: DD-017 §5 stamps
 * `Settings.vaultCutover` at first personal boot, `TT.preCutover` is `date < cutoverDay`, and
 * `frozenEntryRefusal` 403s the PUT before any of those suites' real assertions are reached.
 *
 * TAKEN FROM THE STAMP, NEVER FROM THE CLOCK, and that is the point rather than a preference.
 * `vaultCutover` is an ISO instant in UTC while a local `todayStr()` is a local day, so the two
 * disagree for a couple of hours a night (SB-147) — a `todayStr()` here would go red by the
 * clock again, and intermittently, which is worse than the bug it replaced. `preCutover` is a
 * strict `<`, so the cutover day ITSELF is the nearest day that is never pre-cutover.
 *
 * It answers the DATE clause only. A day inside a committed segment is frozen by the ledger
 * clause whatever its date (DD-017 §2), so a suite with commits in its data dir must pick its
 * own day — every caller here boots a fresh `mkdtemp` dir with an empty ledger.
 *
 * Under `team` there is no cutover and no freeze at all, so any day does; the clock is used
 * there because nothing can overtake it.
 * @param {any} state the body of a `GET /api/state`
 * @returns {string} a `YYYY-MM-DD` that `frozenEntryRefusal` will not refuse
 */
export function unfrozenDay(state) {
  const cutoverDay = String(state?.settings?.vaultCutover || '').slice(0, 10);
  // Every path into `personal` stamps — the boot (server/src/index.js) and `putSettings`
  // (server/src/db.js) both — so an unstamped personal install means the stamp moved, and the
  // fallback below would quietly go back to choosing a day by the clock. Say so instead.
  if (state?.shape === 'personal')
    expect(cutoverDay, 'a personal install reported no vault cutover').toMatch(/^\d{4}-\d{2}-\d{2}$/);
  return cutoverDay || new Date().toISOString().slice(0, 10);
}

// ---- SB-165 / DD-023: comparing table rows without comparing their padding ----
//
// Since DD-023 TT writes Obsidian's ALIGNED form, so a cell is as wide as the widest cell in its
// column. That makes a byte-literal like `'| 30m | Tidying |'` couple a test to every other row of
// its fixture's table: add one longer label and an assertion about backslash-escaping fails for a
// reason that has nothing to do with escaping. These compare CELL BY CELL instead, for the many
// assertions whose subject is a cell's CONTENT rather than the column widths.
//
// Built on `TT.splitCells` — the parser's own primitive, pinned by its own tests — and
// deliberately NOT on `TT.normaliseVaultPayloadLine` or `TT.vaultAlignedTable`. Those two are what
// DD-023 introduced and must not be the instrument that checks themselves. The alignment itself is
// pinned by the hand-written anchor golden and the recorded real-Obsidian tables in
// roundtrip.test.js, which is where a claim about Obsidian's formatter belongs.
//
// One home rather than a copy per file — SB-161's ruling, and the same failure it was fixing.

/** A table line's trimmed, still-escaped cells. @param {string} line @returns {string[]} */
export const rowCellsOf = (line) => TT.splitCells(line.trim().slice(1, -1)).map((cell) => cell.trim());

/**
 * Does `block` contain this table row, ignoring DD-023's alignment padding?
 * @param {string} block @param {string} row written compactly, as `| a | b |`
 * @returns {boolean}
 */
export const containsRow = (block, row) => {
  const want = JSON.stringify(rowCellsOf(row));
  return block
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .some((line) => JSON.stringify(rowCellsOf(line)) === want);
};
