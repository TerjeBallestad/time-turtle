#!/usr/bin/env node
// Time Turtle — local app runner. Mirrors the pm CLI's ergonomics: a globally
// linked command that runs the BUILT app (client/dist served by the API on one
// origin) in the background, with a PID + log file so it can be stopped cleanly.
//
//   tt serve [--data DIR] [--port N] [--build]   build if needed, run in the background
//   tt stop [--data DIR]                         stop the background server
//   tt restart [--data DIR] [--build] [--port N] stop, then serve
//   tt status [--data DIR]                       is it running, and where?
//   tt build                                     rebuild the client bundle
//   tt logs [--data DIR]                         print the log file path + last lines
//
// The DB, mirror, PID and log all live under server/data — or under --data DIR, or
// TT_DATA_DIR when the flag is absent. That directory *is* the instance: two data dirs
// on two ports are two independent installs sharing one checkout. Within one data dir
// this runner shares state with `npm run dev` — use one or the other, not both at once.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const [cmd = 'help', ...rest] = process.argv.slice(2);
const has = (name) => rest.includes('--' + name);
const opt = (name, def) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
};

// Which instance is this command about? --data wins, TT_DATA_DIR is the fallback,
// server/data is the default. A bare `--data` with no directory after it is an error:
// silently falling back to the default data dir would aim the command at the wrong install.
if (has('data') && !opt('data', null)) {
  console.error('✗ --data needs a directory: tt ' + cmd + ' --data <dir>');
  process.exit(1);
}
const DATA_FLAG = opt('data', null);
const DATA = DATA_FLAG
  ? resolve(DATA_FLAG)
  : process.env.TT_DATA_DIR
    ? resolve(process.env.TT_DATA_DIR)
    : join(REPO, 'server', 'data');
/** Did the caller name an instance, or are we on the default data dir? */
const DATA_CHOSEN = Boolean(DATA_FLAG || process.env.TT_DATA_DIR);
const PID_FILE = join(DATA, '.tt-serve.pid');
const LOG_FILE = join(DATA, 'tt-serve.log');
const DIST = join(REPO, 'client', 'dist');
const SERVER = join(REPO, 'server', 'src', 'index.js');
const DEFAULT_PORT = +(process.env.PORT || 3001);

const port = () => +opt('port', DEFAULT_PORT);

/** What the pid file says: {pid, port, alive}, or null when there is no readable one. */
function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const [pidStr, portStr] = readFileSync(PID_FILE, 'utf8').trim().split(/\s+/);
  const pid = +pidStr;
  if (!pid) return null;
  let alive = true;
  try {
    process.kill(pid, 0); // signal 0 = existence check
  } catch {
    alive = false; // process is gone; the pid file is stale
  }
  return { pid, port: +portStr || DEFAULT_PORT, alive };
}
/** The live server {pid, port}, or null. Pure: reading never touches the pid file. */
function live() {
  const p = readPid();
  return p && p.alive ? { pid: p.pid, port: p.port } : null;
}
/**
 * Delete a pid file that names no live process; returns the stale pid, or null.
 * Only the commands that already write the data dir call this — `status` is a
 * query and leaves the dir byte-identical (SB-108).
 */
function pruneStalePid() {
  const p = readPid();
  if (p && !p.alive) {
    unlinkSync(PID_FILE);
    return p.pid;
  }
  return null;
}
/** Resolve true if something is already listening on the port. */
const portBusy = (p) =>
  new Promise((res) => {
    const s = createConnection({ port: p, host: '127.0.0.1' });
    s.on('connect', () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
  });
async function waitListening(p, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await portBusy(p)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
function build() {
  console.log('· building client…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('✗ build failed');
    process.exit(1);
  }
}

async function serve() {
  const p = port();
  const running = live();
  if (running) {
    console.log(`already running · pid ${running.pid} · http://localhost:${running.port}  (use: tt restart)`);
    return;
  }
  pruneStalePid(); // serve writes this dir anyway — the hygiene lives here, not in status
  if (await portBusy(p)) {
    console.error(`✗ port ${p} is already in use — is \`npm run dev\` running? Stop it, or: tt serve --port <N>`);
    process.exit(1);
  }
  if (has('build') || !existsSync(DIST)) build();
  else console.log('· serving existing client/dist (refresh it with: tt build)');
  mkdirSync(DATA, { recursive: true });
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', log, log],
    // TT_DATA_DIR follows the flag: the server must open the same instance the
    // pid file, log and this runner are pointed at.
    env: { ...process.env, PORT: String(p), TT_DATA_DIR: DATA },
  });
  writeFileSync(PID_FILE, `${child.pid} ${p}`);
  child.unref();
  if (!(await waitListening(p))) {
    console.error(`✗ server did not come up within 10s — check the log:\n  ${LOG_FILE}`);
    process.exit(1);
  }
  console.log(`✓ Time Turtle · http://localhost:${p} · pid ${child.pid}\n  data: ${DATA}\n  log: ${LOG_FILE}`);
}

/**
 * Name the instance the command just answered for. With two instances in play an
 * unqualified answer is ambiguous (SB-099, SB-108). `hint` adds the sibling caveat,
 * which only a *negative* answer needs — and it stays a static line, never a scan
 * (DD-015 — no process manager over instances).
 */
function where({ hint = false } = {}) {
  console.log(`data: ${DATA}`);
  if (hint && !DATA_CHOSEN) {
    console.log('(this is the default data dir — other instances may be running under their own --data dirs)');
  }
}

function stop() {
  const s = live();
  if (!s) {
    const stalePid = pruneStalePid();
    console.log(stalePid ? `not running · cleared a stale pid file (pid ${stalePid})` : 'not running');
    where({ hint: true });
    return;
  }
  try {
    process.kill(s.pid);
  } catch {
    /* already dead */
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  console.log(`stopped · pid ${s.pid}`);
  where();
}

function status() {
  // A query: it reports a stale pid file, it does not delete one. The sweep belongs
  // to the commands that already write the data dir — serve / stop / restart (SB-108).
  const p = readPid();
  if (p && p.alive) console.log(`running · pid ${p.pid} · http://localhost:${p.port}`);
  else if (p) console.log(`stopped · stale pid file (pid ${p.pid}) — the next serve/stop/restart clears it`);
  else console.log('stopped');
  where({ hint: true });
}

function logs() {
  console.log(LOG_FILE);
  if (existsSync(LOG_FILE)) {
    const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n');
    console.log('\n' + lines.slice(-20).join('\n'));
  }
}

const HELP = `Time Turtle — local app runner

  tt serve [--data DIR] [--port N] [--build]  build if needed, run in the background
  tt stop [--data DIR]                        stop the background server
  tt restart [--data DIR] [--build] [--port N]  stop, then serve
  tt status [--data DIR]                      is it running, and where?
  tt build                                    rebuild the client bundle
  tt logs [--data DIR]                        the log file path + last lines

Serves the built client + API on one origin (default :3001). State (DB, mirror,
pid, log) lives under the data dir — server/data by default, \`--data DIR\` to pick
another, \`TT_DATA_DIR\` as the fallback when the flag is absent. Within one data dir
it shares state with \`npm run dev\`; run one at a time.

A data dir + a port is an instance. Two of them are two independent installs that
happen to share this checkout — see "Two shapes, two instances" in the README:

  tt serve --data ~/.time-turtle/personal --port 3002`;

switch (cmd) {
  case 'serve':
  case 'up':
    await serve();
    break;
  case 'stop':
  case 'down':
    stop();
    break;
  case 'restart':
    stop();
    await serve();
    break;
  case 'status':
    status();
    break;
  case 'build':
    build();
    break;
  case 'logs':
    logs();
    break;
  default:
    console.log(HELP);
}
