// SB-098 item 4 at the BROWSER rung, which is the rung the ticket names for it — and it names
// it because this repo has live proof that perfect plumbing with no control is indistinguishable
// from nothing: SB-063 shipped `vaultTimeSeparator` with a green api test and no UI at all, and
// SB-056 had to come back and build the control.
//
// So `POST /api/shape` returning 200 (tests/shape-choice.test.js) is NOT this claim. This claim
// is that a human opening Time Turtle for the first time meets a question, in words about what
// the install IS, cannot get past it without answering, and gets the shape they asked for.
//
// THE ANSWER THAT MATTERS MOST IS "my company's". The open state resolves to an effective `team`
// (DD-015: `team` is the safe row), so that answer is the user clicking the shape they are
// already effectively on — and `setShape`'s early return, which is correct for the Settings
// toggle, would silently swallow it: nothing stored, the question still open, asked again on the
// next load. The `personal` answer works either way. That is what makes it easy to ship broken.
//
// ## Verified red-green: 2026-07-26 (output TRANSCRIBED from the runs, not reconstructed)
//   See the stanza above each test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './harness.js';

/** Read `/api/state` through the page's own origin, so the browser's cookie (if any) rides along. */
function stateFromPage(page) {
  return page.evaluate(() => fetch('/api/state').then((r) => r.json()));
}

describe('SB-098 item 4: the first-run question', () => {
  /** @type {Awaited<ReturnType<typeof startApp>> | null} */
  let app = null;
  beforeAll(async () => {
    // No TT_SHAPE, nothing stored, one user: DD-015's open state, which is what a genuinely
    // fresh install IS. `onboarding: true` leaves the question unanswered for us.
    app = await startApp({ onboarding: true });
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-26, TRANSCRIBED. ABSENCE — `{state.shapeOpen && <ShapeChoice
  //   ui={ui} />}` removed from App.tsx, i.e. the plumbing shipped with no control, which is
  //   precisely SB-063's failure — 3 of 3 fail, and the first one is the honest one:
  //     FAIL  a fresh install is asked, in shape words, and cannot get past it
  //           TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  //           waiting for locator('[data-tt="shape-choice"]') to be visible
  //     FAIL  answering "my company's" … / the install becomes personal …
  //           TimeoutError: locator.click: Timeout 30000ms exceeded.
  //           waiting for locator('[data-tt="shape-choice-team"]')  /  …-personal
  it('a fresh install is asked, in shape words, and cannot get past it', async () => {
    const modal = app.page.locator('[data-tt="shape-choice"]');
    await modal.waitFor({ timeout: 15000 });

    const text = await modal.innerText();
    // SHAPE LANGUAGE. The two answers are about whose hours these are, never about a storage
    // engine — DD-015's whole point is that the backend is derived and nobody selects one.
    expect(text).toContain('My own Obsidian-backed timesheet');
    expect(text).toContain('My company’s');
    expect(text.toLowerCase()).not.toContain('sqlite');
    expect(text.toLowerCase()).not.toContain('backend');

    // NOT SKIPPABLE. There is no × and no dismiss, the scrim does not close on a click, and
    // Escape does nothing — the two answers ARE the escape, and `team` is the safe half.
    await app.page.keyboard.press('Escape');
    await app.page.mouse.click(20, 20); // the scrim, well clear of the card
    await expect.poll(() => modal.isVisible()).toBe(true);

    // And the app behind it is genuinely unreachable while it stands: the sidebar is under the
    // scrim, so a click on it is intercepted rather than merely ignored.
    const blocked = await app.page
      .locator('text=Settings')
      .first()
      .click({ timeout: 2000 })
      .then(() => null)
      .catch((err) => String(err.message));
    expect(blocked).toMatch(/intercepts pointer events|Timeout/);
  }, 120000);

  // ## Verified red-green: 2026-07-26, TRANSCRIBED. THE TRAP — `ui.chooseShape` pointed at
  //   `ui.setShape` instead, i.e. the first-run question built on the Settings toggle, which is
  //   the mistake this whole test exists to catch — 1 of 3 fails, and it fails as the SYMPTOM
  //   rather than as a flag: the click does nothing at all, so the question is still there.
  //     FAIL  answering "my company's" — the shape already in force — closes the question for good
  //           TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  //           waiting for locator('[data-tt="shape-choice"]') to be detached
  //             34 × locator resolved to visible <div data-tt="shape-choice" …>…</div>
  //   The `personal` test below stays GREEN under that same mutation. That asymmetry is the
  //   entire reason this one is written first and separately.
  it('answering "my company\'s" — the shape already in force — closes the question for good', async () => {
    await app.page.locator('[data-tt="shape-choice-team"]').click();
    await app.page.locator('[data-tt="shape-choice"]').waitFor({ state: 'detached', timeout: 15000 });

    // The app is reachable now, and it is the team app: the Users section is back.
    await app.page.locator('text=Settings').first().click();
    await app.page.locator('button:has-text("+ user")').first().waitFor({ timeout: 15000 });

    // It STUCK. A reload is the moment a swallowed answer would show itself.
    await app.page.reload();
    await app.page.locator('text=Settings').first().waitFor({ timeout: 15000 });
    expect(await app.page.locator('[data-tt="shape-choice"]').count()).toBe(0);

    const state = await stateFromPage(app.page);
    expect(state.shape).toBe('team');
    expect(state.shapeOpen).toBe(false);
    // Stored, not merely resolved: `settings.shape` carries the STORED value since SB-133, and
    // it being present at all is the difference between an answer and a default.
    expect(state.settings.shape).toBe('team');
  }, 120000);
});

describe('SB-098 item 4: answering "my own Obsidian-backed timesheet"', () => {
  /** @type {Awaited<ReturnType<typeof startApp>> | null} */
  let app = null;
  beforeAll(async () => {
    app = await startApp({ onboarding: true });
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-26, TRANSCRIBED. ABSENCE (the modal removed from App.tsx) —
  //   this fails on the same waitFor as the first test. The interesting mutation is the CHANNEL:
  //   `api.setShape` pointed back at `putState({ settings: { ...state.settings, shape } })` —
  //   which still passes, correctly, because the shared PUT does still accept a shape (SB-139 is
  //   deliberately left open). What that mutation proves is that this test is about the ANSWER
  //   reaching the install, not about which endpoint carried it.
  it('the install becomes personal, and the identity surface goes with it', async () => {
    await app.page.locator('[data-tt="shape-choice-personal"]').click();
    await app.page.locator('[data-tt="shape-choice"]').waitFor({ state: 'detached', timeout: 15000 });

    const state = await stateFromPage(app.page);
    expect(state.shape).toBe('personal');
    expect(state.shapeOpen).toBe(false);

    // The promise the question makes, kept on the same screen it was made on (item 3): a fresh
    // install that answers "mine" and is then handed a Users section has been sold a shape it
    // did not get.
    await app.page.locator('text=Settings').first().click();
    await app.page.locator('button:has-text("+ client")').first().waitFor({ timeout: 15000 });
    expect(await app.page.locator('button:has-text("+ user")').count()).toBe(0);

    // And it survives a reload — including the login screen never coming back, which is item 1
    // seen from the browser: `requireUser` resolved the local session with no cookie.
    await app.page.reload();
    await app.page.locator('text=Settings').first().waitFor({ timeout: 15000 });
    expect(await app.page.locator('[data-tt="shape-choice"]').count()).toBe(0);
    expect(await app.page.locator('button:has-text("Sign in")').count()).toBe(0);
  }, 120000);
});
