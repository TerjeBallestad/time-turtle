// The Week view's commit chips and verbs, at the BROWSER rung — a chip is a thing on a screen, and
// a green api test cannot see one.
//
// Moved out of personal-week-mark.test.js when the shape concept was removed (SB-181), which is
// also what removed the pre-vault mark this file used to assert the absence of.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './harness.js';

/** Open the Week view from the sidebar and wait for its heading. */
async function gotoWeek(page) {
  await page.locator('text=This week').first().click();
  await page.locator('h1:has-text("Week")').waitFor({ timeout: 15000 });
}

/** Step the week nav and wait for the heading to actually change, rather than sleeping. */
async function stepWeek(page, arrow) {
  const before = await page.locator('h1').first().textContent();
  await page.locator(`button:has-text("${arrow}")`).first().click();
  for (let i = 0; i < 100; i++) {
    if ((await page.locator('h1').first().textContent()) !== before) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`the week nav never moved from ${before}`);
}

/**
 * What the Week view is showing, named by what a person reads. Class names are hashed in the
 * built bundle, so the labels are the only stable anchors.
 */
async function weekSurfaces(page) {
  return {
    chipRow: await page.locator('[data-tt="week-seg-row"]').count(),
    openChip: await page.getByText('open', { exact: true }).count(),
    commitVerb: await page.locator('button:has-text("commit")').count(),
    // The add-row is the thing no test below this rung can see: a locked grid renders no NewRow,
    // so its input is simply not in the DOM. Both placeholders, because NewRow uses the long one
    // on an empty day and `+ add` on a day that already has rows.
    addRow: await page.locator('input[placeholder="+ add"], input[placeholder="12:00-13:00 · 5h…"]').count(),
  };
}

describe('the Week view', () => {
  /** @type {Awaited<ReturnType<typeof startApp>> | null} */
  let app = null;
  beforeAll(async () => {
    app = await startApp();
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  it('shows the verbs and the `open` chips', async () => {
    await gotoWeek(app.page);
    const now = await weekSurfaces(app.page);
    expect(now.openChip, 'no `open` chip').toBeGreaterThan(0);
    expect(now.commitVerb, 'no `commit` verb').toBeGreaterThan(0);
    expect(now.addRow, 'no add-row').toBeGreaterThan(0);

    // and a week in the past is ordinary too — its grids stay editable and its chips committable
    await stepWeek(app.page, '‹');
    const past = await weekSurfaces(app.page);
    expect(past.openChip, 'a past week lost its `open` chip').toBeGreaterThan(0);
    expect(past.addRow, 'a past week lost its add-row').toBeGreaterThan(0);
    expect(app.pageErrors, 'the page threw').toEqual([]);
  }, 120000);
});
