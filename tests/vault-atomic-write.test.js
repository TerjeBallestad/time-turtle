// SB-057 task 3 — the atomic vault write, and the one property that matters.
//
// The claim is NOT "the file gets written". It is: a reader that opens the target at the worst
// possible instant sees the whole OLD file or the whole NEW one, never a torn one. Three readers
// do exactly that in real life — git's `add` during SB-068's daily checkpoint, Obsidian's file
// watcher, and iCloud's uploader propagating an intermediate to the other machine.
//
// So test 2 kills a real child process with a real SIGKILL, between the staging and the rename.
// A `try/finally` would not do: a finally block runs, a SIGKILL does not, and the whole question
// is what survives when nothing runs. The child calls the PRODUCTION staging function, so what is
// under test is this repo's code and not a replica of it in the test.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeVaultFile, stageVaultFile, sweepVaultTemps } from '../server/src/vault-fs.js';

const VAULT_FS = resolve(dirname(fileURLToPath(import.meta.url)), '../server/src/vault-fs.js');

/** @type {string} */
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-atomic-'));
});
const temps = (d) => readdirSync(d).filter((f) => f.startsWith('.tt-') && f.endsWith('.tmp'));

const NOTE = '# Monday\n\n## Time Log\n\n| Time | Bill |\n|---|---|\n| 09:00→10:00 | ✓ |\n\n`revision: 3 · abcd`\n';

describe('the atomic vault write', () => {
  it('writes the whole file and leaves no temp behind', () => {
    const path = join(dir, 'Calendar', 'Daily', '2026-07-20.md');
    expect(writeVaultFile(path, NOTE)).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(NOTE);
    // the directories were created on the way — a vault whose daily folder does not exist yet is
    // the first-write case, not an error
    expect(temps(dirname(path))).toEqual([]);
  });

  it('puts the temp in the SAME DIRECTORY as its target', () => {
    // Cheap, and it is the property a future refactor breaks first. `rename()` is atomic only
    // within a filesystem: a temp in /tmp is a cross-device COPY, which is the torn write this
    // primitive exists to prevent, reintroduced by the fix for it.
    const path = join(dir, 'notes', '2026-07-21.md');
    mkdirSync(dirname(path), { recursive: true });
    const tmp = stageVaultFile(path, NOTE);
    expect(dirname(tmp)).toBe(dirname(path));
    expect(existsSync(path)).toBe(false); // staging has not touched the target
    expect(readFileSync(tmp, 'utf8')).toBe(NOTE);
  });

  it('a process killed between the write and the rename leaves the target WHOLLY OLD', () => {
    const path = join(dir, '2026-07-22.md');
    const before = '# Monday\n\nthe hours that were already here\n';
    writeFileSync(path, before);

    // The child stages through the real production function and then SIGKILLs itself. Nothing
    // after that line runs — no rename, and no cleanup of any kind.
    const killed = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(VAULT_FS)}).then((m) => {
           m.stageVaultFile(${JSON.stringify(path)}, ${JSON.stringify('# REPLACEMENT\\n')});
           process.kill(process.pid, 'SIGKILL');
           m.commitVaultFile('never', 'reached');
         });`,
      ],
      { encoding: 'utf8' },
    );
    // assert the kill actually happened before asserting what it cost — a child that exited
    // normally would make every assertion below meaningless
    expect(killed.signal).toBe('SIGKILL');

    expect(readFileSync(path, 'utf8')).toBe(before); // wholly old: not truncated, not partial
    const orphans = temps(dir);
    expect(orphans).toHaveLength(1); // the debris really is left behind…
    expect(sweepVaultTemps(dir)).toEqual(orphans); // …and the sweep is what removes it
    expect(temps(dir)).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before); // the sweep did not touch the note
  });

  it('the same child WITHOUT the kill leaves the target wholly new', () => {
    // The control. Without it, a `writeVaultFile` that silently did nothing would pass the test
    // above perfectly.
    const path = join(dir, '2026-07-23.md');
    writeFileSync(path, '# Monday\n\nthe hours that were already here\n');
    const ok = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(VAULT_FS)}).then((m) =>
           m.writeVaultFile(${JSON.stringify(path)}, ${JSON.stringify(NOTE)}));`,
      ],
      { encoding: 'utf8' },
    );
    expect(ok.status).toBe(0);
    expect(ok.signal).toBe(null);
    expect(readFileSync(path, 'utf8')).toBe(NOTE);
    expect(temps(dir)).toEqual([]);
  });

  it('the sweep matches on prefix AND suffix, so a real note is never a candidate', () => {
    writeFileSync(join(dir, '.tt-2026-07-24.md-99-1.tmp'), 'debris');
    writeFileSync(join(dir, '.tt-a-note-that-starts-like-a-temp.md'), 'a note');
    writeFileSync(join(dir, 'ordinary.tmp'), 'not ours');
    expect(sweepVaultTemps(dir)).toEqual(['.tt-2026-07-24.md-99-1.tmp']);
    expect(existsSync(join(dir, '.tt-a-note-that-starts-like-a-temp.md'))).toBe(true);
    expect(existsSync(join(dir, 'ordinary.tmp'))).toBe(true);
    // never throws on a directory that is not there — a sweep has nothing to say about whether
    // TT should start
    expect(sweepVaultTemps(join(dir, 'no-such-folder'))).toEqual([]);
  });

  it('two writes in one process do not collide on a temp name', () => {
    const a = join(dir, 'a.md');
    const b = join(dir, 'b.md');
    const first = stageVaultFile(a, 'A');
    const second = stageVaultFile(b, 'B');
    expect(first).not.toBe(second);
    expect(readFileSync(first, 'utf8')).toBe('A');
    expect(readFileSync(second, 'utf8')).toBe('B');
  });
});

// ## Verified red-green: 2026-07-26
