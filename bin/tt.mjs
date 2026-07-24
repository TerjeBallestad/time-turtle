#!/usr/bin/env node
// Time Turtle — local app runner. Mirrors the pm CLI's ergonomics: a globally
// linked command that runs the BUILT app (client/dist served by the API on one
// origin) in the background, with a PID + log file so it can be stopped cleanly.
//
//   tt serve [--port N] [--build]   build if needed, run in the background
//   tt stop                         stop the background server
//   tt restart [--build] [--port N] stop, then serve
//   tt status                       is it running, and where?
//   tt build                        rebuild the client bundle
//   tt logs                         print the log file path + last lines
//
// The DB, mirror, PID and log all live under server/data (or TT_DATA_DIR), so this
// runner shares state with `npm run dev` — use one or the other, not both at once.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.TT_DATA_DIR ? resolve(process.env.TT_DATA_DIR) : join(REPO, 'server', 'data');
const PID_FILE = join(DATA, '.tt-serve.pid');
const LOG_FILE = join(DATA, 'tt-serve.log');
const DIST = join(REPO, 'client', 'dist');
const SERVER = join(REPO, 'server', 'src', 'index.js');
const DEFAULT_PORT = +(process.env.PORT || 3001);

const [cmd = 'help', ...rest] = process.argv.slice(2);
const has = (name) => rest.includes('--' + name);
const opt = (name, def) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
};
const port = () => +opt('port', DEFAULT_PORT);

/** The live server {pid, port}, or null (clearing a stale pid file on the way). */
function live() {
  if (!existsSync(PID_FILE)) return null;
  const [pidStr, portStr] = readFileSync(PID_FILE, 'utf8').trim().split(/\s+/);
  const pid = +pidStr;
  if (!pid) return null;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return { pid, port: +portStr || DEFAULT_PORT };
  } catch {
    unlinkSync(PID_FILE); // process is gone; the pid file was stale
    return null;
  }
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
    env: { ...process.env, PORT: String(p) },
  });
  writeFileSync(PID_FILE, `${child.pid} ${p}`);
  child.unref();
  if (!(await waitListening(p))) {
    console.error(`✗ server did not come up within 10s — check the log:\n  ${LOG_FILE}`);
    process.exit(1);
  }
  console.log(`✓ Time Turtle · http://localhost:${p} · pid ${child.pid}\n  log: ${LOG_FILE}`);
}

function stop() {
  const s = live();
  if (!s) {
    console.log('not running');
    return;
  }
  try {
    process.kill(s.pid);
  } catch {
    /* already dead */
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  console.log(`stopped · pid ${s.pid}`);
}

function status() {
  const s = live();
  if (s) console.log(`running · pid ${s.pid} · http://localhost:${s.port}`);
  else console.log('stopped');
}

function logs() {
  console.log(LOG_FILE);
  if (existsSync(LOG_FILE)) {
    const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n');
    console.log('\n' + lines.slice(-20).join('\n'));
  }
}

const HELP = `Time Turtle — local app runner

  tt serve [--port N] [--build]    build if needed, run the app in the background
  tt stop                          stop the background server
  tt restart [--build] [--port N]  stop, then serve
  tt status                        is it running, and where?
  tt build                         rebuild the client bundle
  tt logs                          the log file path + last lines

Serves the built client + API on one origin (default :3001). State (DB, mirror,
pid, log) lives under server/data — so it shares data with \`npm run dev\`; run one
at a time.`;

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
