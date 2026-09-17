// Committing, approving and releasing a segment, end to end against a real server, as the admin.
//
// Moved from shape-committing.test.js when the shape concept was removed (SB-181): this was its
// `team` contrast case, and it lost only `TT_MD_DIR`.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startServer, stopServer, stopAllServers, adminOn } from './util.js';

afterAll(stopAllServers);

const DATE = '2026-07-26';
const KEY = TT.segmentKey(DATE);

/** Log one hour on `date` and commit its segment. Returns the admin session + user id. */
async function logAndCommit(port, id, date, key) {
  const admin = await adminOn(port);
  const me = await admin('GET', '/api/me');
  const state = await admin('GET', '/api/state');
  const entry = { id, date, start: 540, end: 600, project: null, label: 'gate', note: '', billable: 1 };
  const put = await admin('PUT', '/api/state', {
    entries: [...state.json.entries, entry],
    commits: [...state.json.commits, { key }],
  });
  return { admin, userId: me.json.user.id, put };
}

describe('committing', () => {
  it('commits, approves and releases exactly as it always did', async () => {
    const server = await startServer({ TT_DATA_DIR: mkdtempSync(join(tmpdir(), 'tt-commit-')) });
    const { admin, userId, put } = await logAndCommit(server.port, 'e1-team', DATE, KEY);
    expect(put.status).toBe(200);
    const state = await admin('GET', '/api/state');
    expect(state.json.commits.map((c) => c.key)).toContain(KEY);

    expect((await admin('POST', `/api/users/${userId}/segments/${KEY}/approve`, {})).status).toBe(200);
    expect((await admin('POST', `/api/users/${userId}/segments/${KEY}/release`, {})).status).toBe(200);
    await stopServer(server.child);
  }, 40000);
});
