// DD-024 / SB-158 at the BROWSER rung — the first minutes a person actually meets.
//
// WHY THIS RUNG AND NOT `api`. Every claim here is about what is or is not ON A SCREEN, and this
// repo has live proof that the alternative is indistinguishable from nothing: SB-063 shipped a
// setting with a green api test and no UI at all. `POST /api/first-run` answering 200
// (tests/first-run-open.test.js) is NOT the claim below. The claim is that a person who installs
// Time Turtle fresh meets one question, cannot get past it without answering, and lands on a login
// screen that states the credential nobody ever showed them.
//
// Reduced by SB-181, which removed the shape concept: the question used to be "whose hours is this
// install for", with a vault step behind one answer. What is left is the demo step, and the two
// cases about the question itself moved here from onboarding-shape.test.js when that file
// dissolved.
//
// ## Verified red-green: 2026-07-31 — see the stanza above each case.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, ADMIN_EMAIL, ADMIN_PASSWORD, PUBLISHED_PASSWORD } from './harness.js';

/** Read `/api/state` through the page's own origin, so the browser's cookie (if any) rides along. */
const stateFromPage = (page) => page.evaluate(() => fetch('/api/state').then((r) => r.json()));

/** Sign in, the way a person meets the login screen after finishing the first run. */
async function signIn(page) {
  await page.locator('input[type=text]').waitFor({ timeout: 15000 });
  await page.locator('input[type=text]').fill(ADMIN_EMAIL);
  await page.locator('input[type=password]').fill(ADMIN_PASSWORD);
  await page.locator('button:has-text("Sign in")').click();
  await page.locator('text=Settings').first().waitFor({ timeout: 15000 });
}

describe('DD-024: a fresh install answers the question before it is asked for a credential', () => {
  let app = null;
  beforeAll(async () => {
    app = await startApp({ onboarding: true });
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE PRE-DD-024 BEHAVIOUR, restored — App.tsx's
  //   401 branch put back to a bare `<Login onLogin={…} />` with no first-run probe, i.e. SB-158's
  //   finding exactly. Every case in this file fails, as the SYMPTOM rather than as a flag: a login
  //   form the person has no password for is the only thing on screen.
  //     FAIL  the first screen is the question, and there is no login form on it
  //           TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  //           waiting for locator('[data-tt="first-run"]') to be visible
  it('the first screen is the question, and there is no login form on it', async () => {
    await app.page.locator('[data-tt="first-run"]').waitFor({ timeout: 15000 });
    expect(await app.page.locator('input[type=password]').count()).toBe(0);
    expect(await app.page.locator('button:has-text("Sign in")').count()).toBe(0);
    // And no app behind it either: the sidebar's sync row is on every screen of the real app.
    expect(await app.page.locator('[data-tt="sync-status"]').count()).toBe(0);
    // And the server agrees it owes an answer, rather than the client having decided so on its own.
    const probe = await app.page.evaluate(() => fetch('/api/first-run').then((r) => r.json()));
    expect(probe.open).toBe(true);
    expect(app.pageErrors).toEqual([]);
  }, 120000);

  // ## Verified red-green: 2026-07-26, TRANSCRIBED (as `a fresh install is asked, in shape words,
  //   and cannot get past it`). ABSENCE — the first-run branch removed from App.tsx, i.e. the
  //   plumbing shipped with no control, which is precisely SB-063's failure:
  //     FAIL  a fresh install is asked the first-run question and cannot get past it
  //           TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  //           waiting for locator('[data-tt="first-run"]') to be visible
  it('a fresh install is asked the first-run question and cannot get past it', async () => {
    const card = app.page.locator('[data-tt="first-run"]');
    await card.waitFor({ timeout: 15000 });

    const text = await card.innerText();
    expect(text).toContain('Start with something in it?');

    // NOT SKIPPABLE. There is no × and no dismiss, the scrim does not close on a click, and
    // Escape does nothing — answering it IS the escape, and the empty timesheet is the safe half.
    await app.page.keyboard.press('Escape');
    await app.page.mouse.click(20, 20); // the scrim, well clear of the card
    await expect.poll(() => card.isVisible()).toBe(true);

    // And there is nothing else on the screen to get past it TO.
    expect(await app.page.locator('button:has-text("Sign in")').count()).toBe(0);
    expect(await app.page.locator('[data-tt="sync-status"]').count()).toBe(0);
  }, 120000);

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE PRE-DD-024 LANGUAGE PATH — `TT.lang =
  //   preSessionLang(lang)` removed from above App.tsx's early returns, i.e. the flow rendering
  //   with `TT.lang` still at its `'en'` import default, which is what every pre-session screen did
  //   before this plan:
  //     FAIL  a Norwegian browser meets the whole flow in Norwegian
  //           AssertionError: the first-run question rendered in English to a Norwegian browser:
  //           expected 'Time Turtle\n\nStart with something…' to contain 'Starte med noe i den?'
  it('a Norwegian browser meets the whole flow in Norwegian', async () => {
    // A SECOND CONTEXT, not a second server: the language of a pre-session screen is a property of
    // the BROWSER, because there is no session yet to hold a preference. This is the only signal a
    // genuinely fresh install has, and asserting it needs a browser that reports one.
    const context = await app.browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'nb-NO' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${app.port}`);

    const card = page.locator('[data-tt="first-run"]');
    await card.waitFor({ timeout: 15000 });
    const asked = await card.innerText();
    expect(asked, 'the first-run question rendered in English to a Norwegian browser').toContain(
      'Starte med noe i den?',
    );
    expect(asked).toContain('Start med en tom timeliste'); // the button, which names what it does
    expect(asked).not.toContain('Start with something in it?');

    // AND THE SCREEN AFTER IT. `TT.t` keys ON the English string, so a pair nobody wrote falls
    // through to English in silence — which an assertion on the question alone would never see.
    await page.locator('[data-tt="first-run-demo-submit"]').click();
    await page.locator('button:has-text("Logg inn")').waitFor({ timeout: 15000 });
    expect(await page.locator('text=E-post').count()).toBeGreaterThan(0);

    expect(errors).toEqual([]);
    await context.close();
  }, 120000);
});

describe('DD-024: finishing the first run', () => {
  let app = null;
  beforeAll(async () => {
    app = await startApp({ onboarding: true });
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-26, TRANSCRIBED (as `answering "Team" — the shape already in
  //   force — closes the question for good`). THE TRAP — the answer stored through a compare-first
  //   gesture, so the click does nothing at all and the question is still there:
  //     FAIL  finishing the first run closes the question for good
  //           TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  //           waiting for locator('[data-tt="first-run"]') to be detached
  it('finishing the first run closes the question for good', async () => {
    // The demo box is left unchecked — this case is about the answer sticking, and
    // `tests/first-run-seed.test.js` owns what the checkbox does.
    await app.page.locator('[data-tt="first-run-demo-submit"]').click();

    // THE WALL DD-024 CLAUSE 2 CLOSES: finishing the first run lands the person on a login screen.
    // That is correct — an install asking for credentials is the point — and it is exactly why the
    // starting-password note exists (the case below owns that claim).
    await signIn(app.page);

    // The app is reachable now: the Users section is there.
    await app.page.locator('text=Settings').first().click();
    await app.page.locator('button:has-text("+ user")').first().waitFor({ timeout: 15000 });

    // It STUCK. A reload is the moment a swallowed answer would show itself.
    await app.page.reload();
    await app.page.locator('text=Settings').first().waitFor({ timeout: 15000 });
    expect(await app.page.locator('[data-tt="first-run"]').count()).toBe(0);

    // And the server agrees the question is over.
    const probe = await app.page.evaluate(() => fetch('/api/first-run').then((r) => r.json()));
    expect(probe.open).toBe(false);
    const state = await stateFromPage(app.page);
    expect(state.user.role).toBe('admin');
  }, 120000);
});

describe('DD-024 clause 2: the wall finishing the first run lands you on', () => {
  let app = null;
  beforeAll(async () => {
    // No TT_ADMIN_PASSWORD, so the seeded admin carries the password this repo publishes — the
    // one and only condition under which `<Login>` may state a credential back.
    app = await startApp({ onboarding: true, defaultPassword: true });
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE NOTE REMOVED — `<Login>`'s `defaultLogin`
  //   block deleted, i.e. the wall this plan built and did not close — 1 of 1 fails:
  //     FAIL  a person who finishes the first run is told the password nobody ever showed them
  //           TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  //           waiting for locator('[data-tt="login-default-credentials"]') to be visible
  //   THE GATE, mutated separately: `firstRunCaller`'s peer check dropped so the hint rides on the
  //   Host header alone — every case in THIS file stays green, because they all speak from
  //   loopback. That is why the LAN half and the retirement are api-rung cases (the DD-024 clause 2
  //   block in tests/first-run-open.test.js): this rung structurally cannot see either.
  it('a person who finishes the first run is told the password nobody ever showed them', async () => {
    await app.page.locator('[data-tt="first-run-demo-submit"]').click();

    const hint = app.page.locator('[data-tt="login-default-credentials"]');
    await hint.waitFor({ timeout: 15000 });
    const text = await hint.innerText();
    expect(text).toContain(ADMIN_EMAIL);
    expect(text).toContain(PUBLISHED_PASSWORD);

    // IT IS USABLE, not decorative: the credential on screen is the one that signs in.
    await app.page.locator('input[type=text]').fill(ADMIN_EMAIL);
    await app.page.locator('input[type=password]').fill(PUBLISHED_PASSWORD);
    await app.page.locator('button:has-text("Sign in")').click();
    await app.page.locator('text=Settings').first().waitFor({ timeout: 15000 });
    expect(app.pageErrors).toEqual([]);
  }, 180000);
});
