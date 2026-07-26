// SB-108: `tt status` is a query — it reports a stale pid file, it never deletes one —
// and every branch of `tt stop` names the instance it answered for.
//
// Two findings, one file (`bin/tt.mjs`):
//
//  1. `stop` printed a bare `not running` / `stopped · pid N`. With two instances on one
//     machine (personal + team demo, SB-092/SB-099) that answer means "not running *here*"
//     and the reader cannot tell which "here". `serve` and `status` already name the data
//     dir; `stop` now does too, in both branches, with the same sibling hint `status` prints
//     when no instance was named.
//  2. `live()` used to `unlinkSync` a stale pid file as a side effect, so `tt status` — a
//     read — mutated the data dir. The sweep now lives in `pruneStalePid()`, called only by
//     the commands that already write the dir (`serve`, `stop`, `restart`). The hygiene was
//     moved, not dropped.
//
// The real binary is driven here, not imported: `bin/tt.mjs` is a top-level-await script with
// no exports, and both findings are properties of what a user sees on stdout and what is left
// on disk afterwards. No server is spawned — every case below is decided by the pid file
// alone, which is what keeps this in the fast `npm test` gate.
//
// The stale pid is a process we spawned and reaped, not a guessed number: a made-up pid can
// belong to a live process (flake), or to root (`process.kill` throws EPERM and it reads as
// stale). A pid that just exited is unambiguously gone.
//
// ## Verified red-green: 2026-07-26 (output transcribed from the runs, not reconstructed)
//
//   Mutation 1 — the pre-SB-108 shape restored: `unlinkSync(PID_FILE)` back in the catch of
//   the pid read, and `status` reading through `live()` so a stale file just reads "stopped".
//   3 failed | 4 passed:
//     × leaves a data dir holding a stale pid file byte-identical
//       AssertionError: expected { 'note.txt': '10:1785086463058.365' } to deeply equal { …(2) }
//     × names the stale pid file rather than silently removing it
//       AssertionError: expected 'stopped\ndata: /var/folders/9z/ct9q0q…' to contain 'stale pid file'
//     × clears the stale pid file and says so
//       AssertionError: expected 'not running\ndata: /var/folders/9z/ct…' to contain 'cleared a stale pid file'
//     (the third because the *read* had already eaten the file before `stop` could sweep it —
//     the side effect does not merely write, it steals the write from the command that owns it.)
//
//   Mutation 2 — drop `where()` from stop's not-running branch. 3 failed | 4 passed:
//     × names the data dir when there is nothing running
//       AssertionError: expected 'not running\n' to contain 'data: /var/folders/9z/ct9q0qr50wq_yyq…'
//     × clears the stale pid file and says so
//     × drops the sibling hint when an instance was named, and keeps it when none was
//
//   Mutation 3 — `stop` stops pruning (`const stalePid = null`). 1 failed | 6 passed:
//     × clears the stale pid file and says so
//       AssertionError: expected 'not running\ndata: /var/folders/9z/ct…' to contain 'cleared a stale pid file'
//
//   Restored: 7 passed.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TT = join(ROOT, 'bin', 'tt.mjs');

const dirs = [];
function throwawayData() {
  const d = mkdtempSync(join(tmpdir(), 'tt-sb108-'));
  dirs.push(d);
  mkdirSync(d, { recursive: true });
  // A bystander file, so "the dir is untouched" is a claim about the dir and not only
  // about the pid file.
  writeFileSync(join(d, 'note.txt'), 'bystander\n');
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Run the real CLI. Never inherits TT_DATA_DIR — every case names its own instance. */
function tt(args, { env = {} } = {}) {
  const clean = { ...process.env };
  delete clean.TT_DATA_DIR; // never let an ambient instance decide what this test aimed at
  const r = spawnSync(process.execPath, [TT, ...args], {
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

/** A pid that is certainly gone: spawn a process, let it exit, keep its number. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  return r.pid;
}

/** name → size+mtime for every file in the dir, so a stray write cannot hide. */
const snapshot = (d) =>
  Object.fromEntries(
    readdirSync(d)
      .sort()
      .map((f) => {
        const s = statSync(join(d, f));
        return [f, `${s.size}:${s.mtimeMs}`];
      }),
  );

describe('tt status is read-only (SB-108)', () => {
  let data;
  beforeEach(() => {
    data = throwawayData();
  });

  it('leaves a data dir holding a stale pid file byte-identical', () => {
    writeFileSync(join(data, '.tt-serve.pid'), `${deadPid()} 3099`);
    const before = snapshot(data);

    const { out, code } = tt(['status', '--data', data]);

    expect(code).toBe(0);
    expect(snapshot(data)).toEqual(before);
    expect(readdirSync(data).sort()).toEqual(['.tt-serve.pid', 'note.txt']);
    expect(out).toContain(`data: ${data}`);
  });

  it('names the stale pid file rather than silently removing it', () => {
    const gone = deadPid();
    writeFileSync(join(data, '.tt-serve.pid'), `${gone} 3099`);

    const { out } = tt(['status', '--data', data]);

    expect(out).toContain('stale pid file');
    expect(out).toContain(String(gone));
    // Still the right answer about the thing the user asked: nothing is serving.
    expect(out).toMatch(/^stopped/);
    expect(out).not.toContain('running · pid');
  });

  it('still reports a live pid as running, and writes nothing', () => {
    // This test process is the "server": alive for certain, and never signalled.
    writeFileSync(join(data, '.tt-serve.pid'), `${process.pid} 3099`);
    const before = snapshot(data);

    const { out } = tt(['status', '--data', data]);

    expect(out).toContain(`running · pid ${process.pid} · http://localhost:3099`);
    expect(snapshot(data)).toEqual(before);
  });

  it('says nothing about staleness when there is no pid file at all', () => {
    const { out } = tt(['status', '--data', data]);
    expect(out).toMatch(/^stopped\n/);
    expect(out).not.toContain('stale');
    expect(out).toContain(`data: ${data}`);
  });
});

describe('tt stop names the instance, and keeps the hygiene (SB-108)', () => {
  let data;
  beforeEach(() => {
    data = throwawayData();
  });

  it('names the data dir when there is nothing running', () => {
    const { out, code } = tt(['stop', '--data', data]);
    expect(code).toBe(0);
    expect(out).toMatch(/^not running/);
    expect(out).toContain(`data: ${data}`);
  });

  it('clears the stale pid file and says so', () => {
    const gone = deadPid();
    writeFileSync(join(data, '.tt-serve.pid'), `${gone} 3099`);

    const { out } = tt(['stop', '--data', data]);

    expect(out).toContain('cleared a stale pid file');
    expect(out).toContain(String(gone));
    expect(out).toContain(`data: ${data}`);
    expect(readdirSync(data).sort()).toEqual(['note.txt']);
  });

  it('drops the sibling hint when an instance was named, and keeps it when none was', () => {
    const named = tt(['stop', '--data', data]);
    expect(named.out).not.toContain('default data dir');

    // TT_DATA_DIR is the fallback, not a flag — but it is still a named instance.
    const viaEnv = tt(['stop'], { env: { TT_DATA_DIR: data } });
    expect(viaEnv.out).toContain(`data: ${data}`);
    expect(viaEnv.out).not.toContain('default data dir');
  });
});
