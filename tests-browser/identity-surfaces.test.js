// The identity surface, at the BROWSER rung — "it is on the page" is a claim about a screen, and
// nothing below the browser can make it. An api test can prove the server serves a user list; it
// cannot prove there is a Users section to reach it from.
//
// Moved out of personal-no-identity.test.js when the shape concept was removed (SB-181). That file
// asserted these five surfaces were ABSENT under `personal` and present under `team`; there is one
// kind of install now, so what is left is the half that says they are here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './harness.js';

/**
 * The five identity surfaces, counted on the page as it stands. Named by the text a person reads,
 * because that is the level the claim is made at — and because CSS-module class names are hashed,
 * so the labels are the only stable anchors in the built bundle anyway.
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

describe('the identity surface', () => {
  /** @type {Awaited<ReturnType<typeof startApp>> | null} */
  let app = null;
  beforeAll(async () => {
    app = await startApp();
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-26, TRANSCRIBED (as `every surface the personal shape removes is
  //   still here under team`). The `identity` gates forced off (`const identity = false`) — 1 fails:
  //     FAIL  every identity surface is on the page
  //           AssertionError: expected 0 to be greater than 0
  it('every identity surface is on the page', async () => {
    const found = await identitySurfaces(app.page);
    expect(found.usersSection).toBeGreaterThan(0);
    expect(found.passwordSection).toBeGreaterThan(0);
    expect(found.reviewNav).toBeGreaterThan(0);
    expect(found.signOut).toBeGreaterThan(0);
    expect(found.roleChip).toBeGreaterThan(0);
  }, 120000);
});
