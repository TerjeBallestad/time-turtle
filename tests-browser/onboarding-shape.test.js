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
// UPDATED FOR DD-024, and the update is the whole finding SB-158 filed: the question used to be
// reachable only by first clearing a login form, using a password nobody was ever shown. It now
// comes FIRST, with no credential, and answering `Team` is what puts the login screen there. So the
// sign-in in these cases moved from before the question to after it. `tests-browser/first-run.test.js`
// owns the claims that are new; this file keeps its original subject — the QUESTION.
//
// ## Verified red-green: 2026-07-26 (output TRANSCRIBED from the runs, not reconstructed)
//   See the stanza above each test.
// ## Verified red-green: 2026-07-31 — see the DD-024 stanzas.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, ADMIN_EMAIL, ADMIN_PASSWORD } from './harness.js';

/** Sign in, the way a person meets the login screen after answering `Team`. */
async function signIn(page) {
  await page.locator('input[type=text]').waitFor({ timeout: 15000 });
  await page.locator('input[type=text]').fill(ADMIN_EMAIL);
  await page.locator('input[type=password]').fill(ADMIN_PASSWORD);
  await page.locator('button:has-text("Sign in")').click();
}

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
  // ## Verified red-green: 2026-07-31, TRANSCRIBED. `ShapeChoice.tsx` reverted to its pre-SB-153
  //   wording (`My company’s`, and the team body's engine-free sentence) — 1 of 1 in this case
  //   fails, on the two assertions that ARE the ruling:
  //     FAIL  a fresh install is asked, in shape words, and cannot get past it
  //           AssertionError: expected '…My own Obsidian-backed timesheet…My company’s…' to
  //           contain 'Team'
  it('a fresh install is asked, in shape words, and cannot get past it', async () => {
    const modal = app.page.locator('[data-tt="shape-choice"]');
    await modal.waitFor({ timeout: 15000 });

    const text = await modal.innerText();
    // SHAPE LANGUAGE. The two answers are about whose hours these are — nobody has to answer
    // "sqlite or vault" to start logging hours, and neither option asks them to.
    expect(text).toContain('My own Obsidian-backed timesheet');
    // SB-153, ruled by Terje: `My company’s` → `Team`, the word Settings → Vault already uses.
    expect(text).toContain('Team');
    expect(text).not.toContain('My company’s');
    // AND THE RIDER, which is the bigger half of that ruling and deliberately inverts what this
    // line asserted before: the team option NAMES SQLITE. The personal option already names its
    // engine, so the question was only ever engine-free on one side, which left `Team` reading as
    // the vague default. `backend` stays banned — after DD-015/SB-100 that word means a value
    // nobody selects, so it is the one storage word this screen must not use.
    expect(text.toLowerCase()).toContain('sqlite');
    expect(text.toLowerCase()).not.toContain('backend');

    // NOT SKIPPABLE. There is no × and no dismiss, the scrim does not close on a click, and
    // Escape does nothing — the two answers ARE the escape, and `Team` is the safe half.
    await app.page.keyboard.press('Escape');
    await app.page.mouse.click(20, 20); // the scrim, well clear of the card
    await expect.poll(() => modal.isVisible()).toBe(true);

    // DD-024: and there is nothing else on the screen to get past it TO. This used to assert that
    // the sidebar behind the scrim intercepted the click; on a fresh install there is no longer an
    // app behind it and no login form either, which is SB-158's finding closed.
    expect(await app.page.locator('button:has-text("Sign in")').count()).toBe(0);
    // The sidebar's sync row, which every screen of the real app carries — not `text=Settings`,
    // which the question's own closing line contains ("…later under Settings → Vault").
    expect(await app.page.locator('[data-tt="sync-status"]').count()).toBe(0);
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
  it('answering "Team" — the shape already in force — closes the question for good', async () => {
    await app.page.locator('[data-tt="shape-choice-team"]').click();
    // DD-024 clause 3: `Team` leads to the demo step, opt-in and off by default. Left unchecked
    // here — this case is about the shape answer sticking, and `tests/first-run-seed.test.js`
    // owns what the checkbox does.
    await app.page.locator('[data-tt="first-run-demo-submit"]').click();

    // THE WALL DD-024 CLAUSE 2 CLOSES: answering `Team` lands the person on a login screen. That
    // is correct — a team install asking for credentials is the point — and it is exactly why the
    // starting-password note exists (first-run.test.js owns that claim).
    await signIn(app.page);

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
    // DD-024 / SB-140: `personal` leads to the vault step, and it is not skippable — an install
    // sold an Obsidian-backed timesheet with no vault is an ordinary local timesheet.
    // `first-run.test.js` owns the un-skippability itself; here it is just the road to the app.
    await app.page.locator('[data-tt="first-run-vault-root"]').fill(app.vaultDir);
    await app.page.locator('[data-tt="first-run-vault-submit"]').click();
    await app.page.locator('[data-tt="first-run"]').waitFor({ state: 'detached', timeout: 15000 });

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
