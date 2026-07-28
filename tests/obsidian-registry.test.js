// SB-140 / DD-024 — reading Obsidian's own vault registry, so the first run can OFFER rather than
// ask someone to type a path.
//
// FIXTURES ONLY. Not one assertion here reads
// `~/Library/Application Support/obsidian/obsidian.json`, and that is a hard rule rather than a
// preference: a test against the real file passes on exactly one machine and proves nothing about
// the parse. Every case below writes its own registry into a temp dir.
//
// THE UNIT RUNG IS THE RIGHT ONE HERE and the api rung is not. This is a pure parse — a string in,
// a list out — and the only filesystem it touches is the fixture it was handed. Whether the
// PREFILL reaches a person is task 4's browser claim, not this file's.
//
// ## Verified red-green: 2026-07-28, TRANSCRIBED. The module was written before its tests, so the
// red comes from mutations rather than from absence — three, each reddening exactly one case:
//   THE `open` PREFERENCE dropped (registry order wins):
//     FAIL  several registered vaults are all offered, with the open one first
//           AssertionError: expected [ 'Ideaverse', 'ballestad', 'Scratch' ] to deeply equal
//                           [ 'ballestad', 'Ideaverse', 'Scratch' ]
//   `directoryExists` WEAKENED to `existsSync` alone:
//     FAIL  a file is not a vault, however much it exists
//           AssertionError: expected true to be false // Object.is equality
//   THE ENTRY-SHAPE FILTER dropped — and it does not merely mis-answer, it throws, which is the
//   500-on-the-first-screen this module exists to avoid:
//     FAIL  an entry without a usable path is skipped rather than offered as blank
//           TypeError: The "path" argument must be of type string. Received undefined
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readObsidianVaults, directoryExists, ICLOUD_VAULT_PREFIX } from '../server/src/obsidian-registry.js';

/** A temp dir to hang fixtures off. */
const scratch = (label) => mkdtempSync(join(tmpdir(), 'tt-registry-' + label + '-'));

/** Write a registry file and hand back its path. `body` is written verbatim when it is a string. */
function registry(dir, body) {
  const path = join(dir, 'obsidian.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

/** A real directory, so `missing` is false for the fixtures that want a live vault. */
function vaultDir(dir, name) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('the Obsidian registry, as a source of prefills', () => {
  it('one registered vault is offered', () => {
    const dir = scratch('one');
    const path = vaultDir(dir, 'ballestad');
    const vaults = readObsidianVaults(registry(dir, { vaults: { a1: { path, ts: 100, open: true } } }));

    expect(vaults).toEqual([{ path, name: 'ballestad', open: true, missing: false }]);
  });

  it('several registered vaults are all offered, with the open one first', () => {
    // The case a single-vault fixture structurally cannot see. `open` is ABSENT rather than
    // `false` for a closed vault — that is what the real file does — so the preference must be
    // written as truthiness.
    const dir = scratch('three');
    const ballestad = vaultDir(dir, 'ballestad');
    const ideaverse = vaultDir(dir, 'Ideaverse');
    const scratchpad = vaultDir(dir, 'Scratch');
    const vaults = readObsidianVaults(
      registry(dir, {
        vaults: {
          a1: { path: ideaverse, ts: 300 }, // newest, but not open
          b2: { path: ballestad, ts: 100, open: true },
          c3: { path: scratchpad, ts: 200 },
        },
      }),
    );

    expect(vaults.map((v) => v.name)).toEqual(['ballestad', 'Ideaverse', 'Scratch']);
    expect(vaults[0].open).toBe(true);
    // ALL THREE are offered, not just the winner — the person may well mean one of the others.
    expect(vaults.length).toBe(3);
    // …and the two closed ones are ordered most-recently-used, which is the only signal left.
    expect(vaults.slice(1).map((v) => v.open)).toEqual([false, false]);
  });

  it('a registered path that is no longer on disk is offered, and flagged', () => {
    // Offered rather than dropped: an unmounted drive or an un-synced iCloud folder is still the
    // vault the person means, and omitting it silently leaves them typing a path Obsidian shows.
    const dir = scratch('missing');
    const live = vaultDir(dir, 'here');
    const gone = join(dir, 'not-here');
    const vaults = readObsidianVaults(
      registry(dir, { vaults: { a1: { path: gone, ts: 200 }, b2: { path: live, ts: 100 } } }),
    );

    expect(vaults.map((v) => [v.name, v.missing])).toEqual([
      ['not-here', true],
      ['here', false],
    ]);
  });

  it('an absent registry is an empty list, not a throw', () => {
    // This runs inside a route that answers before any credential exists. A throw there is a 500
    // on the first screen a person ever sees.
    expect(readObsidianVaults(join(scratch('absent'), 'nope.json'))).toEqual([]);
  });

  it('a malformed registry is an empty list, not a throw', () => {
    const dir = scratch('malformed');
    expect(readObsidianVaults(registry(dir, '{ this is not json'))).toEqual([]);
    expect(readObsidianVaults(registry(dir, 'null'))).toEqual([]);
    expect(readObsidianVaults(registry(dir, '[]'))).toEqual([]);
    expect(readObsidianVaults(registry(dir, { vaults: 'nope' }))).toEqual([]);
    expect(readObsidianVaults(registry(dir, { somethingElse: {} }))).toEqual([]);
  });

  it('an entry without a usable path is skipped rather than offered as blank', () => {
    const dir = scratch('junk');
    const good = vaultDir(dir, 'real');
    const vaults = readObsidianVaults(
      registry(dir, {
        vaults: { a1: { ts: 1 }, b2: { path: '', ts: 2 }, c3: { path: 42 }, d4: null, e5: { path: good, ts: 3 } },
      }),
    );

    expect(vaults.map((v) => v.name)).toEqual(['real']);
  });
});

describe('the directory check that stands in front of a stored vault root', () => {
  it('a real directory passes', () => {
    const dir = scratch('dir');
    expect(directoryExists(vaultDir(dir, 'vault'))).toBe(true);
  });

  it('a file is not a vault, however much it exists', () => {
    // The case `existsSync` alone cannot see. Storing a file as `vaultPaths.root` leaves the sync
    // engine reading a directory that is not one.
    const dir = scratch('file');
    const path = join(dir, 'notavault.md');
    writeFileSync(path, '# hello');
    expect(directoryExists(path)).toBe(false);
  });

  it('an absent path fails, and does not throw', () => {
    expect(directoryExists(join(scratch('none'), 'nothing-here'))).toBe(false);
    expect(directoryExists('')).toBe(false);
  });
});

describe('the fallback prefix', () => {
  it('names the macOS iCloud location a vault NAME is composed onto', () => {
    // Exported so the client shows it as fixed text beside the name field rather than restating
    // it — one home for a path that appears in a sentence a person reads.
    expect(ICLOUD_VAULT_PREFIX).toMatch(/Library\/Mobile Documents\/iCloud~md~obsidian\/Documents$/);
  });
});
