// @ts-check
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import TT from '../../shared/core.js';
import { MD_DIR, MD_DIR_LOCKED } from './config.js';
import { getSettings, getClients, getProjects, getTasks, getEntries, getCommits } from './db.js';

// Where mirrors go: the mdDir setting (editable in Settings → Markdown backend,
// e.g. a cloud-synced Obsidian folder) wins over TT_MD_DIR / the default — unless
// TT_MD_DIR_LOCK froze it, in which case any stored setting is ignored (DC-002).
/** @returns {string} */
export function mirrorDir() {
  if (MD_DIR_LOCKED) return MD_DIR;
  const configuredDir = getSettings().mdDir?.trim();
  if (!configuredDir) return MD_DIR;
  return resolve(configuredDir.startsWith('~') ? join(homedir(), configuredDir.slice(1)) : configuredDir);
}

// Mirror one user's timesheet (full catalog + their entries) to a markdown file.
// The file uses the app's round-trippable format — the whole thing can be pasted
// back into the app (admin) if the database is ever lost.
/** @param {import('../../shared/types.ts').User} user @returns {string} */
export function writeMirror(user) {
  const state = {
    settings: getSettings(),
    clients: getClients(),
    projects: getProjects(),
    tasks: getTasks(user.id),
    entries: getEntries(user.id),
    // SDD-002 ruling 4: the mirror carries the full commit ledger (frozen money and
    // all) so a mirror-restore keeps committed history; serializeMd only emits the
    // `## commits` section when it is non-empty.
    commits: getCommits(user.id),
  };
  const slug = TT.slug(user.name || user.email.split('@')[0]);
  const dir = mirrorDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'timesheet-' + slug + '.md');
  const tmp = path + '.tmp';
  writeFileSync(tmp, TT.serializeMd(state), 'utf8');
  renameSync(tmp, path);
  return path;
}
