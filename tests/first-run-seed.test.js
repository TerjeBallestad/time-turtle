// DD-024 clause 3 — a fresh install seeds no demo hours unless the first run asks for them.
//
// TWO CHANGES, ONE MECHANISM. `SEED_DEMO` inverts from opt-out to opt-in, and the demo half of
// `seedIfEmpty` moves out from behind the boot so the first-run answer can ask for it. Admin
// creation stays at boot, unconditionally — every join is keyed `user_id` and the first run assumes
// the row exists.
//
// THE ONLY TEST HERE THAT CAN SEE THE DEFAULT FLIP IS THE FIRST ONE. Every other server-spawning
// site in `tests/` and `tests-browser/` sets `TT_SEED_DEMO` explicitly, and so does
// `startServer`'s own default — so a green suite proves nothing about the unset case. That test
// passes `undefined`, which `child_process` drops from the child's environment entirely.
//
// ## Verified red-green: 2026-07-28
//   See the stanza above each describe block.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer, stopAllServers, session } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  return { TT_DATA_DIR: mkdtempSync(join(tmpdir(), 'tt-' + label + '-')) };
}

/** A bare cookieless fetch — the first run takes no credential and neither does this. */
const bare = async (port, path, init) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
};

const answerFirstRun = (port, body) =>
  bare(port, '/api/first-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ## Verified red-green: 2026-07-28, TRANSCRIBED.
//   ABSENCE, before either change:
//     FAIL  a stock fresh install holds no fabricated hours at all
//           AssertionError: a stock install seeded 4 projects: expected 4 to be +0
//
//   RESTORING THE OPT-OUT DEFAULT (`process.env.TT_SEED_DEMO !== '0'`) — the demo step fails too,
//   and its red is informative rather than incidental: with the boot already seeding,
//   `seedDemoContent()` finds projects and returns false, so the route reports `demo: false` and
//   the person who ASKED for demo content is told it did not happen.
//     FAIL  a stock fresh install holds no fabricated hours at all
//     FAIL  the demo step seeds, and what it seeds is editable
describe('DD-024 clause 3: a fresh install is empty', () => {
  it('a stock fresh install holds no fabricated hours at all', async () => {
    // `undefined` REMOVES the variable from the child's environment (child_process drops undefined
    // values), so this is the genuinely-unset case and not `TT_SEED_DEMO=''`. It is the one
    // assertion in the repo that can see the default flip — every other site passes the value.
    const server = await startServer({ ...dataDir('seed-unset'), TT_SEED_DEMO: undefined });

    const admin = session(server.port);
    const login = await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    expect(login.status, 'the admin user must still be created at boot — every join is keyed user_id').toBe(200);

    const state = await admin('GET', '/api/state');
    expect(state.status).toBe(200);
    expect(state.json.projects.length, `a stock install seeded ${state.json.projects.length} projects`).toBe(0);
    expect(state.json.clients.length).toBe(0);
    expect(state.json.entries.length).toBe(0);

    await stopServer(server.child);
  }, 60000);

  it('TT_SEED_DEMO=1 still seeds at boot, unregressed for every test and script that passes it', async () => {
    const server = await startServer({ ...dataDir('seed-optin'), TT_SEED_DEMO: '1' });

    const admin = session(server.port);
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    const state = await admin('GET', '/api/state');
    expect(state.json.projects.length).toBeGreaterThan(0);
    expect(state.json.entries.length).toBeGreaterThan(0);

    await stopServer(server.child);
  }, 60000);
});

describe('DD-024 clause 3: demo content is a step you ask for', () => {
  it('the demo step seeds, and what it seeds is editable', async () => {
    const server = await startServer({ ...dataDir('seed-team-demo'), TT_SEED_DEMO: undefined });

    const answered = await answerFirstRun(server.port, { demo: true });
    expect(answered.status).toBe(200);
    expect(answered.json.demo).toBe(true);

    const admin = session(server.port);
    await admin('POST', '/api/auth/login', { email: 'admin@timeturtle.local', password: 'testpw' });
    const state = await admin('GET', '/api/state');
    expect(state.json.projects.length).toBeGreaterThan(0);
    expect(state.json.entries.length).toBeGreaterThan(0);

    // Demo rows that cannot be deleted are worse than no demo rows.
    const keep = state.json.entries.slice(1);
    const saved = await admin('PUT', '/api/state', { entries: keep, version: state.json.version });
    expect(saved.status, 'a demo entry could not be deleted').toBe(200);
    const after = await admin('GET', '/api/state');
    expect(after.json.entries.length).toBe(keep.length);

    await stopServer(server.child);
  }, 60000);
});
