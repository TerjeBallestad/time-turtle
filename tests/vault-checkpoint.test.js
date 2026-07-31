// SB-068 — the vault checkpoint. Unit rung, plus one api-rung case for the wiring.
//
// This is filesystem-and-subprocess behaviour, so every case below builds its own THROWAWAY git
// repo under `os.tmpdir()` and drives the real `git` binary against it. Nothing here goes near a
// real vault, and nothing here reads the developer's own repo: `git` always runs with `cwd` set to
// a `mkdtemp` directory this file created and will delete.
//
// THE TWO CLAIMS THAT MATTER, and neither is provable by reading the code:
//
//   1. AT MOST ONE CHECKPOINT PER CALENDAR DAY. It has two halves and they fail differently. The
//      in-process half is the writer's day gate (a second save today takes no second checkpoint);
//      the cross-process half is the `git log` probe (a `tt serve` RESTART today takes no second
//      checkpoint either, because the per-process gate is null in a fresh process). Both are
//      asserted, separately.
//   2. IT NEVER BLOCKS A WRITE. A checkpoint that blocks a write is worse than no checkpoint at
//      all, so the failure cases are not asserted on a return value alone — they are driven
//      through the REAL writer and the assertion is that the hours reached the note anyway.
//
// The last describe is the exception to the unit rung, and it is here because of how this ticket
// failed the first time: the seam existed, was exported, and NOTHING CALLED IT. Every other test
// in this file passes against a completely unwired `server/src/index.js`. That one spawns a real
// server and does not.
//
// What a green run here does NOT prove: anything about Terje's real vault, its size, its iCloud
// behaviour, or how long `git add -A` takes over 25 MB and 1807 loose objects — and nothing about
// what a RESTORE from one of these commits is like, which is a human gesture in Obsidian.
//
// ## Verified red-green: 2026-07-26
// Eleven mutations, each landing on the case that names the property. Whole file green at every
// restore point:
//   · `git log` probe removed              → "a SECOND call the same day … the restart case"
//   · clean-check removed (empty commit)   → "makes NO empty commit"
//   · `add -A` narrowed to `Calendar/Daily`→ "commits the WHOLE worktree …" (+3)
//   · prefix changed to `vault backup:`    → "the message is TT's prefix, never Terje's" (+11)
//   · no-repo branch throws not warns      → "a vault that is not a git repo warns once" (+2)
//   · add-failure throws not warns         → "a locked index …" (+1)
//   · writer day gate removed              → "a second write the same day takes no second …" (+1)
//   · checkpoint moved AFTER the write     → "takes the checkpoint BEFORE the bytes land" (+1)
//   · writer's try/catch removed           → "a hook that THROWS: the write still lands"
//   · `setVaultCheckpointHook` neutered    → the five seam cases
//   · index.js wiring deleted              → "a real server takes the day's checkpoint …", alone
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { vaultCheckpoint, lastCheckpointDayInRepo, CHECKPOINT_PREFIX } from '../server/src/vault-checkpoint.js';
import { startServer, stopServer, stopAllServers, adminOn, seedVaultCatalog } from './util.js';

const DAY = '2026-07-20';
const NEXT_DAY = '2026-07-21';

/** @type {string[]} every temp dir this file made, so afterAll can remove all of them. */
const madeDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

/** Run git in a directory THIS FILE CREATED. Returns stdout VERBATIM; throws if git itself failed. */
function gitRaw(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr || r.stdout}`);
  return r.stdout || '';
}
/** The same, trimmed — for the many one-line answers. */
const git = (dir, ...args) => gitRaw(dir, ...args).trim();

/**
 * A throwaway vault that is a git repo, shaped like the real one: a daily folder, one ordinary
 * committed note, and an identity configured locally so the commit cannot depend on (or be
 * defeated by) whatever global git config this machine has.
 */
function newVaultRepo() {
  const dir = tempDir('tt-ckpt-vault-');
  mkdirSync(join(dir, 'Calendar', 'Daily'), { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@timeturtle.invalid');
  git(dir, 'config', 'user.name', 'Checkpoint Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'a vault\n');
  // THE CATALOG IS PART OF A CLEAN VAULT (DD-026 / PLAN-017). The Cutover lives in this note, and
  // the engine stands down without a readable one — so it has to be here, and it has to be
  // COMMITTED. A seeded-but-untracked note leaves the worktree dirty, and "a clean vault still
  // counts the day as checkpointed" would then be measuring the fixture rather than the rule.
  seedVaultCatalog(dir, { cutover: '2020-01-01' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'vault backup: 2026-07-19 09:00:00');
  return dir;
}

/** Every commit subject, newest first. */
const subjects = (dir) => git(dir, 'log', '--format=%s').split('\n').filter(Boolean);
const checkpoints = (dir) => subjects(dir).filter((s) => s.startsWith(CHECKPOINT_PREFIX));

/** A recorder for the one warning line each failure path is allowed. */
function recorder() {
  /** @type {string[]} */ const warns = [];
  /** @type {string[]} */ const logs = [];
  return { warns, logs, io: { warn: (m) => warns.push(m), log: (m) => logs.push(m) } };
}

afterAll(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

// ============================================================================================
describe('the checkpoint commit', () => {
  it('the first write of a day commits the WHOLE worktree under the tt checkpoint: prefix', () => {
    const vault = newVaultRepo();
    // Two dirty things, and only one of them is TT's. A checkpoint of `Calendar/Daily` alone is
    // not a checkpoint of the vault (SB-066), so the untracked note OUTSIDE TT's folder is the
    // load-bearing half of this assertion.
    writeFileSync(join(vault, 'Calendar', 'Daily', DAY + '.md'), '# Monday\n');
    mkdirSync(join(vault, 'Inbox'), { recursive: true });
    writeFileSync(join(vault, 'Inbox', 'half-typed thought.md'), 'a thought Terje was mid-way through\n');

    const rec = recorder();
    const result = vaultCheckpoint(vault, DAY, rec.io);

    expect(result.taken).toBe(true);
    expect(result.reason).toBe('committed');
    expect(rec.warns).toEqual([]);
    expect(checkpoints(vault)).toHaveLength(1);
    expect(checkpoints(vault)[0]).toMatch(new RegExp(`^${CHECKPOINT_PREFIX}${DAY} \\d\\d:\\d\\d:\\d\\d$`));
    // both files are IN the commit — `add -A`, not a pathspec
    const tracked = git(vault, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    expect(tracked).toContain(`Calendar/Daily/${DAY}.md`);
    expect(tracked).toContain('Inbox/half-typed thought.md');
    // and the worktree is clean afterwards, which is what "checkpoint" means
    expect(git(vault, 'status', '--porcelain')).toBe('');
  });

  it('the message is TT’s prefix, never Terje’s — the two stay filterable', () => {
    // The whole mitigation for TT becoming the majority author of this history (SB-066): his
    // attended `vault backup:` commits must stay findable by a grep that excludes TT's.
    const vault = newVaultRepo();
    writeFileSync(join(vault, 'Calendar', 'Daily', DAY + '.md'), '# Monday\n');
    vaultCheckpoint(vault, DAY, recorder().io);
    expect(git(vault, 'log', '--format=%s', '--grep=^vault backup: ')).toBe('vault backup: 2026-07-19 09:00:00');
    expect(git(vault, 'log', '--format=%s', '--grep=^tt checkpoint: ').split('\n')).toHaveLength(1);
  });

  it('a SECOND call the same day takes no second checkpoint — the restart case', () => {
    // This is the CROSS-PROCESS half of at-most-once-per-day. The writer's day gate is
    // per-process and is null in a fresh process, so three `tt serve` restarts in one day would
    // be three checkpoints without the `git log` probe. Calling `vaultCheckpoint` twice directly
    // IS the restart, because the module holds no state of its own.
    const vault = newVaultRepo();
    writeFileSync(join(vault, 'Calendar', 'Daily', DAY + '.md'), '# Monday\n');
    expect(vaultCheckpoint(vault, DAY, recorder().io).taken).toBe(true);

    writeFileSync(join(vault, 'Calendar', 'Daily', DAY + '.md'), '# Monday, edited since\n');
    const rec = recorder();
    const second = vaultCheckpoint(vault, DAY, rec.io);

    expect(second.taken).toBe(false);
    expect(second.reason).toBe('already-checkpointed');
    expect(checkpoints(vault)).toHaveLength(1);
    expect(rec.warns).toEqual([]); // the rule working is not a warning
    // and it did not stage anything on its way out: a skipped checkpoint leaves the index alone,
    // so a `git add -A` Terje started by hand is not half-done by TT
    expect(git(vault, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(vault, 'status', '--porcelain')).toBe('M Calendar/Daily/2026-07-20.md');
  });

  it('a write on the NEXT day checkpoints again', () => {
    const vault = newVaultRepo();
    writeFileSync(join(vault, 'Calendar', 'Daily', DAY + '.md'), '# Monday\n');
    vaultCheckpoint(vault, DAY, recorder().io);
    // a daemon crossing midnight: same process, same repo, one day later
    writeFileSync(join(vault, 'Calendar', 'Daily', NEXT_DAY + '.md'), '# Tuesday\n');
    const second = vaultCheckpoint(vault, NEXT_DAY, recorder().io);

    expect(second.taken).toBe(true);
    expect(checkpoints(vault)).toHaveLength(2);
    expect(checkpoints(vault)[0]).toContain(`${CHECKPOINT_PREFIX}${NEXT_DAY} `); // newest first
    expect(checkpoints(vault)[1]).toContain(`${CHECKPOINT_PREFIX}${DAY} `);
    expect(lastCheckpointDayInRepo(vault)).toBe(NEXT_DAY);
  });

  it('the day is read from the MESSAGE, not from git’s clock', () => {
    // The probe compares against the day TT stamped, which is the same `TT.todayStr()` the write
    // path used. Reading git's commit date instead would put the two halves of the rule in
    // disagreement about where midnight is — and would make the case above untestable without
    // faking a clock.
    const vault = newVaultRepo();
    expect(lastCheckpointDayInRepo(vault)).toBe(null); // a `vault backup:` commit is not a checkpoint
    writeFileSync(join(vault, 'note.md'), 'x\n');
    vaultCheckpoint(vault, '2019-01-02', recorder().io);
    expect(lastCheckpointDayInRepo(vault)).toBe('2019-01-02');
    expect(git(vault, 'log', '-1', '--format=%cd', '--date=short')).not.toBe('2019-01-02');
  });

  it('a repo with no commits at all still gets its first checkpoint', () => {
    // `git log` exits 128 in an empty repo. Read as an error, that would be a vault that never
    // gets checkpointed; read as "no checkpoint yet", it is the ordinary first-ever case.
    const dir = tempDir('tt-ckpt-empty-');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@timeturtle.invalid');
    git(dir, 'config', 'user.name', 'Checkpoint Test');
    writeFileSync(join(dir, 'first.md'), 'hello\n');

    const rec = recorder();
    expect(vaultCheckpoint(dir, DAY, rec.io).taken).toBe(true);
    expect(rec.warns).toEqual([]);
    expect(checkpoints(dir)).toHaveLength(1);
  });
});

// ============================================================================================
describe('a clean vault', () => {
  it('makes NO empty commit', () => {
    const vault = newVaultRepo();
    const before = subjects(vault);
    const rec = recorder();
    const result = vaultCheckpoint(vault, DAY, rec.io);

    expect(result.taken).toBe(false);
    expect(result.reason).toBe('clean');
    expect(subjects(vault)).toEqual(before); // not one commit more
    expect(rec.warns).toEqual([]); // nothing to commit is not a failure
    expect(rec.logs).toEqual([]);
  });
});

// ============================================================================================
describe('the failure paths — one warning line, and never a throw', () => {
  it('a vault that is not a git repo warns once and returns', () => {
    const plain = tempDir('tt-ckpt-plain-');
    mkdirSync(join(plain, 'Calendar', 'Daily'), { recursive: true });
    const rec = recorder();

    let result;
    expect(() => (result = vaultCheckpoint(plain, DAY, rec.io))).not.toThrow();
    expect(result.taken).toBe(false);
    expect(result.reason).toBe('no-repo');
    expect(rec.warns).toHaveLength(1);
    expect(rec.warns[0]).toContain('not a git worktree');
    expect(rec.warns[0]).toContain('writing anyway');
    expect(existsSync(join(plain, '.git'))).toBe(false); // and it did not helpfully `git init`
  });

  it('git being unavailable warns once and returns', () => {
    // The honest version of "git is missing": the binary cannot be found on PATH. `spawnSync`
    // reports that as `error: ENOENT` rather than by throwing, and it lands in the same branch as
    // a directory that is not a repo — which is the point, since the operator's next move is the
    // same either way.
    const vault = newVaultRepo();
    const realPath = process.env.PATH;
    const rec = recorder();
    let result;
    try {
      process.env.PATH = join(tempDir('tt-ckpt-nogit-'), 'nowhere');
      expect(() => (result = vaultCheckpoint(vault, DAY, rec.io))).not.toThrow();
    } finally {
      process.env.PATH = realPath;
    }
    expect(result.reason).toBe('no-repo');
    expect(rec.warns).toHaveLength(1);
    expect(checkpoints(vault)).toHaveLength(0);
    expect(git(vault, 'status', '--porcelain')).toBe(''); // nothing was staged on the way out
  });

  it('a locked index — obsidian-git committing at the same instant — warns once and returns', () => {
    // The realistic git failure. `index.lock` exists for as long as another git process holds the
    // index, and `git add` refuses outright. Terje takes his own `vault backup:` commits by hand,
    // so this is a collision that will actually happen one day.
    const vault = newVaultRepo();
    writeFileSync(join(vault, 'Calendar', 'Daily', DAY + '.md'), '# Monday\n');
    writeFileSync(join(vault, '.git', 'index.lock'), '');

    const rec = recorder();
    let result;
    expect(() => (result = vaultCheckpoint(vault, DAY, rec.io))).not.toThrow();
    expect(result.taken).toBe(false);
    expect(result.reason).toBe('add-failed');
    expect(rec.warns).toHaveLength(1);
    expect(rec.warns[0]).toContain('writing anyway');
    expect(checkpoints(vault)).toHaveLength(0);
  });

  it('a commit that git refuses warns once and returns', () => {
    // An EMPTY identity, which git refuses to commit under (`fatal: empty ident name`) and which
    // no global config can rescue — unsetting the local keys would just fall through to the
    // developer's own `~/.gitconfig` and make this case pass vacuously. `git add` still succeeds,
    // so the failure lands on the commit specifically: the index is left staged, and the write
    // still has to happen.
    const vault = newVaultRepo();
    git(vault, 'config', 'user.email', '');
    git(vault, 'config', 'user.name', '');
    writeFileSync(join(vault, 'Calendar', 'Daily', DAY + '.md'), '# Monday\n');

    const rec = recorder();
    let result;
    expect(() => (result = vaultCheckpoint(vault, DAY, rec.io))).not.toThrow();
    expect(result.taken).toBe(false);
    expect(result.reason).toBe('commit-failed');
    expect(rec.warns).toHaveLength(1);
    expect(rec.warns[0]).toContain('git commit');
    expect(checkpoints(vault)).toHaveLength(0);
  });

  it('an empty root is a no-op, not a checkpoint of the process’s cwd', () => {
    // `vaultPaths.root` is '' until Settings → Vault is filled in. Running `git add -A` with no
    // cwd override would stage whatever directory the server happens to be running from — which,
    // in a dev checkout, is this repository.
    const rec = recorder();
    expect(vaultCheckpoint('', DAY, rec.io)).toEqual({ taken: false, reason: 'no-root' });
    expect(rec.warns).toEqual([]);
    expect(rec.logs).toEqual([]);
  });
});

// ============================================================================================
// The seam: the checkpoint driven by the REAL writer, not called directly.
//
// Everything above proves the checkpoint. This proves the two things only the write path can say:
// the checkpoint happens BEFORE the bytes land, and a failing checkpoint does not cost the user
// their hours.
describe('the checkpoint on the real write path', () => {
  /** @type {typeof import('../server/src/db.js')} */ let db;
  /** @type {typeof import('../server/src/vault-write.js')} */ let writer;
  /** @type {typeof import('../server/src/vault-sync.js')} */ let sync;
  let userId = 0;
  let vaultRoot = '';
  const HEADING = 'Time Log';
  const TODAY = TT.todayStr();
  const notePath = () => join(vaultRoot, 'Calendar', 'Daily', TODAY + '.md');

  const entry = (id, start, end, label) => ({
    id,
    date: TODAY,
    start,
    end,
    durMin: null,
    project: null,
    label,
    note: '',
    billable: true,
  });

  /** The real write path — the same one `store.putEntries` reaches under the vault backend. */
  async function save(entries) {
    const before = db.getEntries(userId);
    db.putEntries(userId, entries);
    return writer.writeVaultEntries(userId, entries, before);
  }

  beforeAll(async () => {
    process.env.TT_DATA_DIR = tempDir('tt-ckpt-data-');
    process.env.TT_SHAPE = 'personal';
    db = await import('../server/src/db.js');
    sync = await import('../server/src/vault-sync.js');
    writer = await import('../server/src/vault-write.js');
    const user = db.createUser({ email: 'solo@timeturtle.local', name: 'Solo', role: 'admin', password: 'pw' });
    userId = user.id;
  });

  beforeEach(async () => {
    vaultRoot = newVaultRepo();
    db.putSettings({ shape: 'personal', vaultPaths: { root: vaultRoot, daily: 'Calendar/Daily' } });
    // The Catalog is seeded and committed by `newVaultRepo` — see the note there.
    for (const row of db.listVaultIndex()) db.deleteVaultIndex(row.path);
    db.putEntries(userId, []);
    sync.forgetOwnWrites();
    // …and READ it: `vaultCutoverInForce()` gates on the index row saying TT read the note.
    await sync.syncVaultCatalog(sync.vaultCatalogConfig());
  });
  afterEach(() => {
    writer.setVaultCheckpointHook(null); // and, with it, the day gate
  });

  it('takes the checkpoint BEFORE the bytes land — the note in the commit is the OLD one', () => {
    // The property the whole ticket exists for. A checkpoint taken after the write would commit
    // exactly the damage it is supposed to protect against, and would look identical on the board.
    const existing = [
      '# Monday',
      '',
      TT.serializeVaultBlock([entry('e1', 540, 600, 'an hour Terje logged himself')], { heading: HEADING, revision: 1 }), // prettier-ignore
      '',
      '## Captures',
      '',
      'a thought',
      '',
    ].join('\n');
    writeFileSync(notePath(), existing);
    git(vaultRoot, 'add', '-A');
    git(vaultRoot, 'commit', '-q', '-m', 'vault backup: 2026-07-19 10:00:00');
    // dirty since that backup, so the checkpoint has something to take
    const onDisk = existing + '\nand a line typed since the last backup\n';
    writeFileSync(notePath(), onDisk);
    writer.setVaultCheckpointHook((day) => vaultCheckpoint(vaultRoot, day, { log: () => {}, warn: () => {} }));

    return (async () => {
      await sync.scanVault(); // the note becomes TT's to write into
      await save([entry('e1', 540, 600, 'an hour Terje logged himself'), entry('e2', 600, 660, 'AN HOUR TT ADDED')]);

      expect(readFileSync(notePath(), 'utf8')).toContain('AN HOUR TT ADDED'); // the write landed
      const inCommit = gitRaw(vaultRoot, 'show', `HEAD:Calendar/Daily/${TODAY}.md`);
      expect(checkpoints(vaultRoot)).toHaveLength(1);
      expect(inCommit).toBe(onDisk); // exactly the pre-write bytes…
      expect(inCommit).not.toContain('AN HOUR TT ADDED'); // …so the checkpoint predates the write
    })();
  });

  it('a second write the same day takes no second checkpoint', () => {
    // The IN-PROCESS half of at-most-once-per-day: the writer's own day gate. Counted at the hook
    // rather than at the commit, so it cannot be satisfied by the repo probe doing the work.
    /** @type {string[]} */ const calls = [];
    writer.setVaultCheckpointHook((day) => {
      calls.push(day);
      vaultCheckpoint(vaultRoot, day, { log: () => {}, warn: () => {} });
    });
    writeFileSync(join(vaultRoot, 'dirty.md'), 'something to checkpoint\n');

    return (async () => {
      await save([entry('e1', 540, 600, 'first hour')]);
      await save([entry('e1', 540, 600, 'first hour'), entry('e2', 600, 660, 'second hour')]);
      await save([entry('e1', 540, 600, 'first hour'), entry('e2', 600, 660, 'second hour'), entry('e3', 660, 720, 'third')]); // prettier-ignore

      expect(calls).toEqual([TODAY]); // three saves, one checkpoint
      expect(checkpoints(vaultRoot)).toHaveLength(1);
      expect(readFileSync(notePath(), 'utf8')).toContain('third'); // and all three saves landed
    })();
  });

  it('a clean vault still counts the day as checkpointed', () => {
    // Nothing to commit → no empty commit, and the day is spent anyway. Without the second half,
    // every save on a quiet morning would re-run `git add -A` over the whole vault.
    /** @type {string[]} */ const calls = [];
    writer.setVaultCheckpointHook((day) => {
      calls.push(day);
      vaultCheckpoint(vaultRoot, day, { log: () => {}, warn: () => {} });
    });

    return (async () => {
      // vaultRoot is a fresh repo with nothing dirty, so the first checkpoint finds nothing…
      await save([entry('e1', 540, 600, 'first hour')]);
      expect(checkpoints(vaultRoot)).toHaveLength(0);
      // …and the second save, which now HAS something to commit, still does not take one
      await save([entry('e1', 540, 600, 'first hour'), entry('e2', 600, 660, 'second hour')]);
      expect(calls).toEqual([TODAY]);
      expect(checkpoints(vaultRoot)).toHaveLength(0);
      expect(readFileSync(notePath(), 'utf8')).toContain('second hour');
    })();
  });

  it('a vault that is not a repo: the write STILL LANDS', () => {
    // The claim that matters most. A checkpoint that blocks a write is worse than no checkpoint.
    vaultRoot = tempDir('tt-ckpt-notrepo-');
    mkdirSync(join(vaultRoot, 'Calendar', 'Daily'), { recursive: true });
    db.putSettings({ shape: 'personal', vaultPaths: { root: vaultRoot, daily: 'Calendar/Daily' } });
    seedVaultCatalog(vaultRoot, { cutover: '2020-01-01' });
    const rec = recorder();
    writer.setVaultCheckpointHook((day) => vaultCheckpoint(vaultRoot, day, rec.io));

    return (async () => {
      // this suite points at a NEW vault root mid-test, so the Catalog has to be read here
      await sync.syncVaultCatalog(sync.vaultCatalogConfig());
      const report = await save([entry('e1', 540, 600, 'an hour that must survive a broken backup')]);
      expect(report.written).toEqual([TODAY]);
      const parsed = TT.parseVaultBlock(readFileSync(notePath(), 'utf8'), { heading: HEADING, date: TODAY });
      expect(parsed.quarantine).toBe(false);
      expect(parsed.entries.map((e) => e.label)).toEqual(['an hour that must survive a broken backup']);
      expect(rec.warns).toHaveLength(1); // one line, once for the day
    })();
  });

  it('a git failure: the write STILL LANDS', () => {
    // Same claim, one rung nastier — the repo is real, so every branch up to `git add` succeeds
    // and the failure happens with a checkpoint half-taken.
    writeFileSync(join(vaultRoot, '.git', 'index.lock'), '');
    const rec = recorder();
    writer.setVaultCheckpointHook((day) => vaultCheckpoint(vaultRoot, day, rec.io));

    return (async () => {
      const report = await save([entry('e1', 540, 600, 'an hour under a locked index')]);
      expect(report.written).toEqual([TODAY]);
      const parsed = TT.parseVaultBlock(readFileSync(notePath(), 'utf8'), { heading: HEADING, date: TODAY });
      expect(parsed.entries.map((e) => e.label)).toEqual(['an hour under a locked index']);
      expect(rec.warns).toHaveLength(1);
      expect(checkpoints(vaultRoot)).toHaveLength(0);
    })();
  });

  it('a hook that THROWS: the write still lands', () => {
    // The writer's own belt. `vaultCheckpoint` promises never to throw; this asserts the writer
    // does not depend on that promise being kept.
    writer.setVaultCheckpointHook(() => {
      throw new Error('the checkpoint exploded');
    });
    return (async () => {
      const report = await save([entry('e1', 540, 600, 'an hour under an exploding hook')]);
      expect(report.written).toEqual([TODAY]);
      expect(readFileSync(notePath(), 'utf8')).toContain('an hour under an exploding hook');
    })();
  });
});

// ============================================================================================
// The wiring, in a REAL server process.
//
// This describe exists because of how SB-068 failed the first time: PLAN-012 shaped the seam,
// `setVaultCheckpointHook` was exported — and NOTHING CALLED IT, so the hook stayed the no-op
// default and the board read the checkpoint as built. Every other test in this file passes with
// `server/src/index.js` completely unwired. This one does not.
//
// A real child process is the only rung that can say it: the wire is a module-load side effect in
// the server's entry point, and it does not exist inside an import of `vault-write.js`.
describe('the wiring (api)', () => {
  /** @type {any} */ let child = null;
  let vault = '';
  let admin = /** @type {any} */ (null);
  const TODAY = TT.todayStr();

  beforeAll(async () => {
    vault = newVaultRepo();
    // dirty, so there is something for the checkpoint to take
    writeFileSync(join(vault, 'Inbox.md'), 'a note Terje has not backed up yet\n');
    const server = await startServer({
      TT_DATA_DIR: tempDir('tt-ckpt-wire-data-'),
      TT_SHAPE: 'personal',
      TT_SEED_DEMO: '0',
    });
    child = server.child;
    admin = await adminOn(server.port);
    const state = await admin('GET', '/api/state');
    expect(state.json.shape).toBe('personal'); // without this every assertion below is vacuous
    const put = await admin('PUT', '/api/state', {
      settings: { vaultPaths: { root: vault, daily: 'Calendar/Daily' } },
      version: state.json.version,
    });
    expect(put.status).toBe(200);
  }, 30000);
  afterAll(async () => {
    if (child) await stopServer(child);
    stopAllServers();
  });

  async function save(entries) {
    const state = await admin('GET', '/api/state');
    const res = await admin('PUT', '/api/state', { entries, version: state.json.version });
    expect(res.status).toBe(200);
  }
  async function until(predicate, timeout = 5000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const hour = (id, start, end, label) => ({
    id,
    date: TODAY,
    start,
    end,
    durMin: null,
    project: null,
    label,
    note: '',
    billable: true,
  });

  it('a real server takes the day’s checkpoint on its first vault write, and only one', async () => {
    await save([hour('w1', 540, 600, 'the first hour of the day')]);
    expect(await until(() => checkpoints(vault).length >= 1)).toBe(true);

    const notePath = join(vault, 'Calendar', 'Daily', TODAY + '.md');
    expect(existsSync(notePath)).toBe(true);
    expect(readFileSync(notePath, 'utf8')).toContain('the first hour of the day');
    expect(checkpoints(vault)).toHaveLength(1);
    expect(checkpoints(vault)[0]).toMatch(new RegExp(`^${CHECKPOINT_PREFIX}${TODAY} \\d\\d:\\d\\d:\\d\\d$`));
    // the checkpoint took the vault as it was BEFORE the hours landed
    expect(git(vault, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toContain('Inbox.md');
    expect(git(vault, 'log', '-1', '--name-only', '--format=')).not.toContain('Calendar/Daily');

    // and a second save the same day adds no second checkpoint
    await save([hour('w1', 540, 600, 'the first hour of the day'), hour('w2', 600, 660, 'the second hour')]);
    expect(await until(() => readFileSync(notePath, 'utf8').includes('the second hour'))).toBe(true);
    expect(checkpoints(vault)).toHaveLength(1);
  }, 30000);
});
