// SB-134: the sidebar's sync line may only claim a write that is actually happening.
//
// It used to read `synced → md`, then `synced → vault` under the shape that wrote neither — a
// STATUS INDICATOR making a positive claim about a write. With the mirror and the vault gone
// (SB-181) the hours live in the server's database and nothing else is written anywhere, so the
// line names no file at all.
//
// A green unit test cannot catch a wrong label: the defect is entirely in what a person reads on
// screen, so this is judged at the browser rung or not at all.
//
// WHAT IT DOES NOT PROVE: that the line is legible at 10–13 px (that is a screenshot's verdict,
// and the pinned sidebar-bottom is the known screenshot-capture quirk — this reads the DOM
// instead), or that the Norwegian reads naturally to a Norwegian.
//
// ## Verified red-green: 2026-07-27 (as `still reads synced → md`), re-pointed 2026-09-17
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './harness.js';

let app;

beforeAll(async () => {
  app = await startApp();
}, 120000);

afterAll(async () => {
  await stopApp(app);
});

/** What the pinned sidebar sync row actually SHOWS — read off the DOM, not off the store. */
async function syncText(page) {
  const row = page.locator('[data-tt="sync-status"]');
  await row.waitFor({ timeout: 20000 });
  return (await row.innerText()).trim();
}

describe('the sidebar sync line', () => {
  it('reads `synced`, and claims no file it does not write', async () => {
    const text = await syncText(app.page);
    expect(text).toBe('synced');
    // the defect, stated as the assertion: no claim about a destination that is not written
    expect(text).not.toContain('→');
    expect(text).not.toContain('md');
    expect(app.pageErrors).toEqual([]);
  }, 60000);
});
