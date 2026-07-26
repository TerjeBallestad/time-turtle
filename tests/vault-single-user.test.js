// SB-056 / DD-006 consequence 1: a vault belongs to one person.
//
// SB-056 names this file's evidence in as many words: "the guard is proven by an api-rung check
// that ACTUALLY ATTEMPTS to create the second user and asserts the rejection. Reading the guard
// code proves nothing." So every case here performs the forbidden act for real.
//
// Three directions, and proving one says nothing about the others:
//   1. POST /api/users under `vault`                     → 403, then the user list still shows one
//   2. switching to `vault` with two users stored        → 403, then /api/state still says sqlite
//   3. BOOTING into `vault` against a multi-user data dir → the process exits non-zero, printing
//      the recovery; and it comes back up under that recovery env
//
// Direction 3 is the one a copied data dir creates and the one no runtime guard can catch: the
// combination arrived, nobody wrote it. It is also the only one whose evidence is a process
// rather than a response.
//
// A BACKEND CLAIM, NOT A ROLE CLAIM — under `vault` there is exactly one user and they are an
// admin, so an admin session is the right evidence here, not a shortcut around the
// role-evidence rule.
//
// ## Verified red-green: 2026-07-26
//   Removing each guard in turn:
//     POST /api/users guard →
//       FAIL  a vault server refuses to create a second user, and the user list still shows one
//             AssertionError: expected 200 to be 403
//     PUT /api/state switch guard →
//       FAIL  switching to vault with two users is refused, and sqlite stays in force
//             AssertionError: expected 200 to be 403
//     boot guard →
//       FAIL  a server booted into vault against a multi-user data dir refuses to start
//             Error: server did not exit within 15000ms — it started instead.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer, stopAllServers, adminOn, runServerUntilExit, session } from './util.js';

afterAll(stopAllServers);

function dataDir(label) {
  const data = mkdtempSync(join(tmpdir(), 'tt-' + label + '-'));
  return { data, md: join(data, 'mirror') };
}

const EMPLOYEE = { email: 'second@timeturtle.local', name: 'Second', role: 'employee', password: 'secondpw' };

describe('the single-user guard — direction 1: a second user under vault', () => {
  it('refuses POST /api/users, and the user list still shows one', async () => {
    const { data, md } = dataDir('single-create');
    const vault = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_BACKEND: 'vault' });
    const admin = await adminOn(vault.port);
    expect((await admin('GET', '/api/state')).json.backend).toBe('vault');

    const created = await admin('POST', '/api/users', EMPLOYEE);
    expect(created.status).toBe(403);
    expect(created.json.error).toMatch(/one person/);

    // THE LIST, not the status. A 500 thrown AFTER the INSERT looks identical from outside.
    const users = await admin('GET', '/api/users');
    expect(users.json.users).toHaveLength(1);
    expect(users.json.users[0].email).toBe('admin@timeturtle.local');
    await stopServer(vault.child);
  }, 40000);
});

describe('the single-user guard — direction 2: switching to vault with users already there', () => {
  it('refuses the switch, leaves sqlite in force, and has not broken adding users', async () => {
    const { data, md } = dataDir('single-switch');
    const sqlite = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(sqlite.port);

    expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);
    expect((await admin('GET', '/api/users')).json.users).toHaveLength(2);

    const state = await admin('GET', '/api/state');
    const put = await admin('PUT', '/api/state', { settings: { ...state.json.settings, backend: 'vault' } });
    expect(put.status).toBe(403);
    expect(put.json.error).toMatch(/2 users/);

    // Still sqlite — the setting did not sneak in behind the refusal.
    const after = await admin('GET', '/api/state');
    expect(after.json.backend).toBe('sqlite');
    expect(after.json.settings.backend).toBe('sqlite');

    // And the guard has not broken sqlite: a THIRD user is still fine.
    expect(
      (await admin('POST', '/api/users', { ...EMPLOYEE, email: 'third@timeturtle.local', name: 'Third' })).status,
    ).toBe(200);
    expect((await admin('GET', '/api/users')).json.users).toHaveLength(3);
    await stopServer(sqlite.child);
  }, 40000);
});

describe('the single-user guard — direction 3: booting into the combination', () => {
  it('refuses to start, prints the recovery, and comes back up under it', async () => {
    // The case a copied data dir or a restored backup creates: nobody wrote anything, the
    // combination simply arrived, so neither runtime guard can fire.
    const { data, md } = dataDir('single-boot');
    const sqlite = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(sqlite.port);
    expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);
    await stopServer(sqlite.child);

    const refused = await runServerUntilExit({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_BACKEND: 'vault' });
    expect(refused.code).not.toBe(0);
    expect(refused.output).toMatch(/refusing to start/);
    expect(refused.output).toMatch(/2/); // it names how many users are in the way
    // The recovery string, verbatim — it is not guessable, because TT_BACKEND alone loses to
    // the stored setting and only the locked form beats it.
    expect(refused.output).toContain('TT_BACKEND_LOCK=1 TT_BACKEND=sqlite');

    // And that string really works: the documented way out has to actually let you back in.
    const recovered = await startServer({
      TT_DATA_DIR: data,
      TT_MD_DIR: md,
      TT_BACKEND: 'sqlite',
      TT_BACKEND_LOCK: '1',
    });
    const back = await adminOn(recovered.port);
    expect((await back('GET', '/api/me')).status).toBe(200);
    expect((await back('GET', '/api/state')).json.backend).toBe('sqlite');
    await stopServer(recovered.child);
  }, 60000);

  it('also refuses to start when it is the STORED setting that says vault', async () => {
    // The nastier shape of the same arrival: one user switches to `vault` legitimately, then a
    // second user is added on a copy of that data dir under sqlite, and the two meet at boot.
    // Nothing in the env says `vault` at all here, which is exactly why TT_BACKEND=sqlite on
    // its own cannot save you.
    const { data, md } = dataDir('single-boot-stored');
    const first = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    let admin = await adminOn(first.port);
    const state = await admin('GET', '/api/state');
    expect((await admin('PUT', '/api/state', { settings: { ...state.json.settings, backend: 'vault' } })).status).toBe(
      200,
    );
    await stopServer(first.child);

    // Add the second user through the recovery env, which is the only way in.
    const viaLock = await startServer({
      TT_DATA_DIR: data,
      TT_MD_DIR: md,
      TT_BACKEND: 'sqlite',
      TT_BACKEND_LOCK: '1',
    });
    admin = await adminOn(viaLock.port);
    expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);
    await stopServer(viaLock.child);

    // Plain restart, nothing in the env: the stored `vault` wins and the boot guard fires.
    const refused = await runServerUntilExit({ TT_DATA_DIR: data, TT_MD_DIR: md });
    expect(refused.code).not.toBe(0);
    expect(refused.output).toMatch(/refusing to start/);

    // And a BARE TT_BACKEND=sqlite is not enough — it loses to the stored setting. This is the
    // whole reason the lock is named in the recovery instead of the plain env var.
    const stillRefused = await runServerUntilExit({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_BACKEND: 'sqlite' });
    expect(stillRefused.code).not.toBe(0);
    expect(stillRefused.output).toMatch(/refusing to start/);
  }, 60000);

  // End-gate review finding. A process whose whole contract is "I refuse to start" must not
  // mutate the vault on its way out — and it did: the DD-011 boot sweep sat above the refusal,
  // so a copied data dir booted into `vault` renamed every mirror file it could find and THEN
  // exited 1. Rename-only means no bytes were lost, but the file the operator was looking at
  // had moved for a boot that never happened.
  it('touches no mirror file on the way out — the refusal runs before the retirement sweep', async () => {
    const { data, md } = dataDir('single-boot-nosweep');
    const sqlite = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(sqlite.port);
    // A real mirror on disk, and a second user, so the boot refusal will fire.
    //
    // Only `currency` in the settings patch, deliberately: spreading the whole settings object
    // would store `backend: 'sqlite'`, and a STORED value beats TT_BACKEND — so the restart
    // below would come up on sqlite and the refusal would never fire. (That is the precedence
    // working; it just makes this a different test.)
    expect((await admin('PUT', '/api/state', { settings: { currency: 'kr' } })).status).toBe(200);
    expect(readdirSync(md).filter((f) => f.endsWith('.md'))).toEqual(['timesheet-admin.md']);
    expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);
    await stopServer(sqlite.child);

    const refused = await runServerUntilExit({ TT_DATA_DIR: data, TT_MD_DIR: md, TT_BACKEND: 'vault' });
    expect(refused.code).not.toBe(0);
    // THE POINT: the file is still there under its own name. Asserting only the exit code would
    // have passed against the ordering bug this test exists to pin.
    expect(readdirSync(md).filter((f) => f.endsWith('.md'))).toEqual(['timesheet-admin.md']);
    expect(existsSync(join(md, 'timesheet-admin.md'))).toBe(true);
  }, 60000);
});

describe('the guard does not fire where it should not', () => {
  it('an employee is still 403 admin-only on POST /api/users under sqlite', async () => {
    // The backend guard sits BEFORE requireAdmin's target, so it must not have swallowed the
    // role check on the way past: an employee gets the role refusal, not the backend one.
    const { data, md } = dataDir('single-role');
    const server = await startServer({ TT_DATA_DIR: data, TT_MD_DIR: md });
    const admin = await adminOn(server.port);
    expect((await admin('POST', '/api/users', EMPLOYEE)).status).toBe(200);

    const employee = session(server.port);
    expect(
      (await employee('POST', '/api/auth/login', { email: EMPLOYEE.email, password: EMPLOYEE.password })).status,
    ).toBe(200);
    const denied = await employee('POST', '/api/users', { ...EMPLOYEE, email: 'x@timeturtle.local' });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe('admin only');
    await stopServer(server.child);
  }, 40000);
});
