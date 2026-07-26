// SB-098 item 3 at the BROWSER rung — "absent, not disabled" is a claim about what is on a
// screen, and nothing below the browser can make it. An api test can prove the server would
// refuse a second user; it cannot prove there is no Users section to try it from, and a greyed
// -out one would pass every server assertion while still telling the one human on this install
// that other humans are a thing here.
//
// EVERY ASSERTION IS MADE TWICE, and the `team` half is not a formality. `expect(count).toBe(0)`
// is the assertion most likely to pass for the wrong reason — a typo in a selector, a renamed
// button, a section that moved — and it would go on passing forever. The contrast run asserts
// the SAME selectors find the surfaces under `team`, so a zero on the personal side means the
// shape removed them and not that the test lost them.
//
// It also pins the thing the ticket is most afraid of, one shape over: `team` comes out of this
// with its identity surface exactly as it was.
//
// ## Verified red-green: 2026-07-26 (output TRANSCRIBED from the runs, not reconstructed)
//   See the stanza above each test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './harness.js';

/**
 * The five surfaces DD-015 depth 2 removes, counted on the page as it stands. Named by the text
 * a person reads, because that is the level the claim is made at — and because CSS-module class
 * names are hashed, so the labels are the only stable anchors in the built bundle anyway.
 */
async function identitySurfaces(page) {
  return {
    usersSection: await page.locator('button:has-text("+ user")').count(),
    passwordSection: await page.locator('input[placeholder="Current password"]').count(),
    reviewNav: await page.locator('text=Review').count(),
    signOut: await page.locator('button:has-text("sign out")').count(),
    roleChip: await page.locator('text=admin').count(),
  };
}

describe('SB-098 item 3: under `personal` the identity surface is absent', () => {
  /** @type {Awaited<ReturnType<typeof startApp>> | null} */
  let app = null;
  beforeAll(async () => {
    app = await startApp({ shape: 'personal' });
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-26, TRANSCRIBED. ABSENCE — the `identity` gates removed from
  //   SettingsView.tsx and Sidebar.tsx (back to `{admin && <UsersSection …>}`, `<PasswordSection
  //   />`, `{admin && <NavRow Review …>}` and an ungated user row), i.e. the shipped behaviour
  //   before this ticket — 2 of 3 fail, and the first names all five at once:
  //     FAIL  none of the five surfaces that presuppose a second human is on the page
  //           AssertionError: expected { usersSection: 1, …(4) } to deeply equal
  //           { usersSection: +0, …(4) }
  //           +   "passwordSection": 1,  +   "reviewNav": 1,  +   "roleChip": 5,
  //           +   "signOut": 1,          +   "usersSection": 1,
  //     FAIL  there is no login screen, because there was never a cookie challenge
  //           AssertionError: expected 3 to be +0 // Object.is equality
  //   (`roleChip` counts 5 rather than 1 because the restored Users section carries the word in
  //   its role picker and in every row; the three password inputs are the restored Password
  //   section's. Both numbers are the surfaces coming back, which is the claim.)
  it('none of the five surfaces that presuppose a second human is on the page', async () => {
    expect(await identitySurfaces(app.page)).toEqual({
      usersSection: 0,
      passwordSection: 0,
      reviewNav: 0,
      signOut: 0,
      roleChip: 0,
    });
  }, 120000);

  // ## Verified red-green: 2026-07-26, TRANSCRIBED. ABSENCE — the implicit-session branch removed
  //   from `requireUser` (server/src/index.js) — the whole `personal` block dies in beforeAll,
  //   because the harness never gets past a login form that should not be there (2 skipped, and
  //   the `team` contrast block below stays green, which is the point):
  //     FAIL  SB-098 item 3: under `personal` the identity surface is absent
  //           TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  //           waiting for locator('text=Settings').first() to be visible
  it('there is no login screen, because there was never a cookie challenge', async () => {
    // The harness never signed in for this app — see startApp. So a Settings page on screen is
    // itself the proof, and these two are the belt: no form, and no way to end the session that
    // there is no way to start again.
    expect(await app.page.locator('button:has-text("Sign in")').count()).toBe(0);
    expect(await app.page.locator('input[type=password]').count()).toBe(0);

    // The surfaces are gone, but the RECORD underneath is not — DD-015 depth 2, and it is what
    // lets a `personal → team` switch put every one of them back with a working account behind
    // it. `user_id 1`, still an admin, still the owner of every row.
    const state = await app.page.evaluate(() => fetch('/api/state').then((r) => r.json()));
    expect(state.user.id).toBe(1);
    expect(state.user.role).toBe('admin');
    expect(state.shape).toBe('personal');
  }, 120000);
});

describe('SB-098 item 3: the contrast — `team` keeps every one of them', () => {
  /** @type {Awaited<ReturnType<typeof startApp>> | null} */
  let app = null;
  beforeAll(async () => {
    app = await startApp();
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-26, TRANSCRIBED. THE LEAK — the `identity` gates rewritten to
  //   fire on every shape (`const identity = false`), i.e. the personal rule reaching the company
  //   deployment, which is the failure SB-099's two-instance setup makes real — 1 of 3 fails:
  //     FAIL  every surface the personal shape removes is still here under team
  //           AssertionError: expected 0 to be greater than 0
  //   This is also what makes the zero-counts above mean something: the same selectors, on the
  //   same built bundle, do find all five when the shape allows them.
  it('every surface the personal shape removes is still here under team', async () => {
    const found = await identitySurfaces(app.page);
    expect(found.usersSection).toBeGreaterThan(0);
    expect(found.passwordSection).toBeGreaterThan(0);
    expect(found.reviewNav).toBeGreaterThan(0);
    expect(found.signOut).toBeGreaterThan(0);
    expect(found.roleChip).toBeGreaterThan(0);
  }, 120000);
});
