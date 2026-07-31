// @ts-check
//
// ---- SB-140 / DD-024: where Obsidian says this person's vaults are ----
//
// The first run's vault step is not skippable, and the difference between a good one and a bad one
// is whether TT can OFFER something. Without `vaultPaths.root` the install that was just sold an
// Obsidian-backed timesheet is an ordinary local timesheet printing `vault sync is idle`, so the
// step has to be easy enough that nobody abandons it.
//
// TWO MECHANISMS, ORDER SETTLED. The registry first, a composed path as the fallback:
//
//   1. THE REGISTRY. `~/Library/Application Support/obsidian/obsidian.json` holds a `vaults` map of
//      `{ path, ts, open? }`. It is strictly more informed than a typed name and it is the only
//      mechanism that can offer a LIST. Read-only, one known path, and nothing else in that
//      directory is touched — no scanning of the home directory.
//   2. THE FALLBACK, when the registry is absent or unreadable. SPECIFIED as a vault-NAME field
//      over the fixed iCloud prefix below, never a raw path box — Terje described that shape
//      directly ("I think this is the default path to obsidian. Then the user should choose their
//      vault. Which is just the name of the folder").
//
//      WHAT SHIPPED IS A RAW PATH BOX whose PLACEHOLDER is the prefix (client/src/components/
//      FirstRun.tsx). This paragraph used to describe the specified version as though it were the
//      built one; PLAN-016's end-gate review found that and corrected it rather than leaving two
//      files asserting a screen nobody wrote. Composing prefix + name makes the step UNANSWERABLE
//      for a vault outside iCloud, and the spec does not say what that person types — so the
//      question went to the gate (SB-175) instead of being decided in an implementation.
//
// `open` IS ABSENT RATHER THAN FALSE for a vault that is not open — measured against the real file,
// not assumed — so the preference is written as truthiness and never as `=== false`.
//
// IT NEVER THROWS. An absent, unreadable or malformed registry returns an empty list and the
// caller falls back. This runs inside a route that answers before any credential exists; a throw
// there is a 500 on the first screen a person ever sees.
//
// THE PATH IS INJECTABLE, and that is a test requirement rather than a configuration feature: NO
// TEST MAY EVER READ THE REAL FILE. One that did would pass on exactly one machine and prove
// nothing about the parse.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

/** The registry Obsidian keeps. Overridable by env so tests can point at a fixture. */
export const OBSIDIAN_REGISTRY =
  process.env.TT_OBSIDIAN_REGISTRY || join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');

/**
 * Where iCloud puts Obsidian vaults on macOS. Exported so the client can put it in front of a
 * person without restating the path — today as the vault field's PLACEHOLDER (see the fallback note
 * in the header, which is not the screen that was specified). Sent only while the first run is
 * open; an answered install has no vault step to prefill.
 */
export const ICLOUD_VAULT_PREFIX = join(homedir(), 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents');

/**
 * Every vault Obsidian has registered, best candidate first.
 *
 * ORDER IS THE ANSWER TO "which one did you mean": the open vault first, then the rest by most
 * recently used. A caller that takes `[0]` gets the right prefill without knowing the rule.
 *
 * `missing: true` marks a registered path that is no longer on disk — OFFERED rather than dropped,
 * because a vault on an unmounted drive or an un-synced iCloud folder is still the one the person
 * means, and silently omitting it would leave them typing a path they can see in Obsidian.
 *
 * @param {string} [registryPath]
 * @returns {import('../../shared/types.ts').ObsidianVault[]}
 */
export function readObsidianVaults(registryPath = OBSIDIAN_REGISTRY) {
  /** @type {Record<string, unknown>} */
  let vaults;
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
    // Every shape of "this is not the file I expected" collapses to the same empty answer: the
    // caller's fallback is the same either way, and guessing at a half-recognised registry is how
    // a first run offers somebody else's folder.
    if (!parsed || typeof parsed !== 'object' || !parsed.vaults || typeof parsed.vaults !== 'object') return [];
    vaults = parsed.vaults;
  } catch {
    return []; // absent, unreadable, or not JSON — all the same to a caller that has a fallback
  }
  const rows = [];
  for (const entry of Object.values(vaults)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = /** @type {{ path?: unknown, ts?: unknown, open?: unknown }} */ (entry);
    if (typeof row.path !== 'string' || !row.path) continue;
    rows.push({
      path: row.path,
      name: basename(row.path),
      open: !!row.open,
      missing: !directoryExists(row.path),
      ts: typeof row.ts === 'number' ? row.ts : 0,
    });
  }
  rows.sort((a, b) => (a.open === b.open ? b.ts - a.ts : a.open ? -1 : 1));
  return rows.map(({ path, name, open, missing }) => ({ path, name, open, missing }));
}

/**
 * Is this an existing DIRECTORY? The check that stands between a composed name and a stored
 * `vaultPaths.root` that points at nothing.
 *
 * `statSync` rather than `existsSync` alone: a FILE at that path exists and is not a vault, and
 * storing it would leave the sync engine reading a directory that is not one. Never throws — a
 * permissions error means TT cannot vouch for the path, which is the same answer as absent.
 * @param {string} path @returns {boolean}
 */
export function directoryExists(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
