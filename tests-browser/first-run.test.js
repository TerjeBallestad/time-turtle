// DD-024 / SB-158 / SB-140 / SB-153 at the BROWSER rung — the five minutes a person actually meets.
//
// WHY THIS RUNG AND NOT `api`. Every claim here is about what is or is not ON A SCREEN, and this
// repo has live proof that the alternative is indistinguishable from nothing: SB-063 shipped
// `vaultTimeSeparator` with a green api test and no UI at all. `POST /api/first-run` answering 200
// (tests/first-run-open.test.js) is NOT the claim below. The claim is that a person who installs
// Time Turtle fresh never sees a login form, cannot finish the personal answer without naming a
// vault, and lands in an install that actually reads and writes that vault.
//
// Committed as Playwright rather than left as a screenshot because every line has a definite
// pass/fail a machine can state — and, unlike an observation, it can go red later. A first-run step
// that quietly stops being reachable is exactly the thing that comes back.
//
// WHAT IT DOES NOT PROVE, and this is the whole reason task 6 files a gate: whether these five
// minutes READ right. Playwright can prove the vault step renders and cannot prove anyone wants to
// answer it, and no assertion here is evidence about the copy register SB-153 and SB-160 leave open.
//
// ## Verified red-green: 2026-07-31 — see the stanza above each case.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, stopApp, until, ADMIN_EMAIL, PUBLISHED_PASSWORD } from './harness.js';

/** Read `/api/state` through the page's own origin, so the browser's cookie (if any) rides along. */
const stateFromPage = (page) => page.evaluate(() => fetch('/api/state').then((r) => r.json()));

/** Today, as the local day the app writes a daily note for — never a UTC slice. */
function todayISO() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
  //   finding exactly. RE-MEASURED 2026-07-31 after the Norwegian case was added — 9 fail, every
  //   case in this file and every one in onboarding-shape.test.js, because the whole surface goes
  //   with it. It fails as the SYMPTOM rather than as a flag: a login form the person has no
  //   password for is the only thing on screen.
  //     FAIL  the first screen is the question, and there is no login form on it
  //           TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  //           waiting for locator('[data-tt="shape-choice"]') to be visible
  //     FAIL  a Norwegian browser meets the whole flow in Norwegian
  //     FAIL  a fresh install is asked, in shape words, and cannot get past it
  //     FAIL  answering "Team" … / the install becomes personal … / the vault step cannot be
  //           skipped … / the hours a person logs land in their vault / the question and Settings
  //           → Vault … / a person who answers `Team` is told the password …
  //           the rest: waiting for locator('[data-tt="shape-choice-team"]') to be visible
  it('the first screen is the question, and there is no login form on it', async () => {
    // `shape-choice` is step 1 and `first-run` is the card the two later steps share — the flow
    // reuses the question component rather than restating its words, so the anchors differ by step.
    await app.page.locator('[data-tt="shape-choice"]').waitFor({ timeout: 15000 });
    expect(await app.page.locator('input[type=password]').count()).toBe(0);
    expect(await app.page.locator('button:has-text("Sign in")').count()).toBe(0);
    // And no app behind it either: the sidebar's sync row is on every screen of the real app.
    expect(await app.page.locator('[data-tt="sync-status"]').count()).toBe(0);
    // And the server agrees it owes an answer, rather than the client having decided so on its own.
    const probe = await app.page.evaluate(() => fetch('/api/first-run').then((r) => r.json()));
    expect(probe.open).toBe(true);
    expect(app.pageErrors).toEqual([]);
  }, 120000);

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE PRE-DD-024 LANGUAGE PATH — `TT.lang =
  //   preSessionLang(lang)` removed from above App.tsx's early returns, i.e. the flow rendering
  //   with `TT.lang` still at its `'en'` import default, which is what every pre-session screen did
  //   before this plan:
  //     FAIL  a Norwegian browser meets the whole flow in Norwegian
  //           AssertionError: the first-run question rendered in English to a Norwegian browser:
  //           expected 'Time Turtle\n\nWhose hours will this …' to contain 'Hvem sine timer'
  //   SECOND MUTATION, the vault-step keys deleted from `i18n.ts` — i.e. an English string shipped
  //   with no Norwegian pair, which `TT.t` swallows silently by keying ON the English:
  //     FAIL  … AssertionError: expected 'Time Turtle\n\nWhich vault keeps thes…' to contain
  //           'Hvilket hvelv'
  //   THIRD MUTATION, the same for the REFUSAL key alone — the string this case was extended to
  //   cover during the end-gate review, because it is the one a person typing a path actually
  //   reads and it was the last English sentence on the flow:
  //     FAIL  … AssertionError: the refusal reached a Norwegian screen in English:
  //           expected 'There is no folder at /no/such/vault' to contain 'Det finnes ingen mappe på'
  it('a Norwegian browser meets the whole flow in Norwegian', async () => {
    // A SECOND CONTEXT, not a second server: the language of a pre-session screen is a property of
    // the BROWSER, because there is no session yet to hold a preference. This is the only signal a
    // genuinely fresh install has, and asserting it needs a browser that reports one.
    const context = await app.browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'nb-NO' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${app.port}`);

    const question = page.locator('[data-tt="shape-choice"]');
    await question.waitFor({ timeout: 15000 });
    const asked = await question.innerText();
    expect(asked, 'the first-run question rendered in English to a Norwegian browser').toContain('Hvem sine timer');
    expect(asked).toContain('Lag'); // SB-153's Norwegian half — the word Settings → Vault uses
    expect(asked).toContain('SQLite-database'); // and its rider, which must survive translation

    // THE STEP AFTER IT TOO. `TT.t` keys ON the English string, so a pair nobody wrote falls
    // through to English in silence — which an assertion on the question alone would never see.
    await page.locator('[data-tt="shape-choice-personal"]').click();
    const step = page.locator('[data-tt="first-run"]');
    await step.waitFor({ timeout: 15000 });
    const vault = await step.innerText();
    expect(vault).toContain('Hvilket hvelv');
    expect(vault).toContain('Hold timene mine');
    expect(vault).not.toContain('Which vault');

    // AND THE REFUSAL, which is the string a person is most likely to actually read on this screen
    // — they are the ones typing the path. It was the LAST English string on the whole flow until
    // the end-gate review moved the sentence from the server's response to the client.
    await page.locator('[data-tt="first-run-vault-root"]').fill('/no/such/vault');
    await page.locator('[data-tt="first-run-vault-submit"]').click();
    // The REFUSAL element, not the card: the card already carries the path in its effect line
    // ("…skriver timene dine inn i /no/such/vault/Calendar/Daily"), so waiting on the card text
    // matches before the round trip even leaves.
    const refusal = page.locator('[data-tt="first-run-error"]');
    await refusal.waitFor({ timeout: 15000 });
    const shown = await refusal.innerText();
    expect(shown, 'the refusal never named the path').toContain('/no/such/vault');
    expect(shown, 'the refusal reached a Norwegian screen in English').toContain('Det finnes ingen mappe på');
    expect(shown).not.toContain('no folder at');

    expect(errors).toEqual([]);
    await context.close();
  }, 120000);
});

describe('DD-024 / SB-140: answering `personal` finishes the install', () => {
  let app = null;
  /** The `Team` option's label, read off the QUESTION before it is answered (SB-153, below). */
  let questionTeamLabel = null;
  beforeAll(async () => {
    app = await startApp({ onboarding: true });
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE STEP MADE SKIPPABLE — the vault submit's
  //   `disabled={!root.trim() || busy}` weakened to `disabled={busy}`, which is the plausible
  //   version of this screen and the one SB-140 exists to forbid. 3 of 6 fail — this case on its
  //   first assertion, and the two after it because the flow never reaches the app:
  //     FAIL  the vault step cannot be skipped, and a path that is not there is refused by name
  //           AssertionError: the vault step could be completed with no vault named:
  //           expected false to be true // Object.is equality
  //   SECOND MUTATION, the route's `directoryExists` validation removed (task 4's guard): the same
  //   case fails one assertion later — the typo is ACCEPTED, the first run ends, and the install is
  //   left pointing at a folder that does not exist. 2 of 6:
  //     FAIL  the vault step cannot be skipped, and a path that is not there is refused by name
  //           AssertionError: expected false to be true // Object.is equality
  //     FAIL  the hours a person logs land in their vault
  //           AssertionError: no daily note was ever written to the vault: expected false to be true
  it('the vault step cannot be skipped, and a path that is not there is refused by name', async () => {
    questionTeamLabel = (await app.page.locator('[data-tt="shape-choice-team"]').innerText()).split('\n')[0].trim();
    await app.page.locator('[data-tt="shape-choice-personal"]').click();

    const root = app.page.locator('[data-tt="first-run-vault-root"]');
    const submit = app.page.locator('[data-tt="first-run-vault-submit"]');
    await root.waitFor({ timeout: 15000 });

    // NOT SKIPPABLE. There is no skip, no "later", and no way to answer with nothing: the registry
    // is empty in this harness, so the field starts blank and the button starts refused.
    expect(await root.inputValue()).toBe('');
    expect(await submit.isDisabled(), 'the vault step could be completed with no vault named').toBe(true);
    expect(await app.page.locator('text=Skip').count()).toBe(0);

    // A TYPO IS REFUSED AND THE REFUSAL NAMES THE PATH — the person is looking at a mistake they
    // cannot otherwise see. And nothing is stored: the first run is still open behind the refusal.
    const missing = join(app.vaultDir, 'not-a-vault');
    await root.fill(missing);
    await submit.click();
    const refused = await until(async () =>
      (await app.page.locator('[data-tt="first-run"]').innerText()).includes(missing),
    );
    expect(refused, 'a path that is not on disk was accepted, or the refusal did not name it').toBe(true);
    expect((await app.page.evaluate(() => fetch('/api/first-run').then((r) => r.json()))).open).toBe(true);

    // The real vault is accepted, and the app it lands in is the personal app: no login screen
    // ever appeared, and the identity surface is gone with the shape.
    await root.fill(app.vaultDir);
    await submit.click();
    await app.page.locator('[data-tt="first-run"]').waitFor({ state: 'detached', timeout: 15000 });
    expect(await app.page.locator('button:has-text("Sign in")').count()).toBe(0);

    const state = await stateFromPage(app.page);
    expect(state.shape).toBe('personal');
    expect(state.shapeOpen).toBe(false);
    expect(state.settings.vaultPaths.root).toBe(app.vaultDir);
    expect(app.pageErrors).toEqual([]);
  }, 180000);

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE HALF-FINISHED INSTALL — `FirstRun`'s submit
  //   changed to post `{ shape: 'personal' }` with the root dropped, which is the state SB-140
  //   describes in as many words: the person answered, the answer stored, and the install they were
  //   sold is an ordinary local timesheet. RE-MEASURED 2026-07-31 — 2 of 6, and the earlier claim
  //   that the case above "stays green" was WRONG: it goes red too, on its LAST assertion rather
  //   than its first, because a root that never travels means the refusal it expects never arrives.
  //     FAIL  the vault step cannot be skipped, and a path that is not there is refused by name
  //           AssertionError: expected false to be true // Object.is equality
  //     FAIL  the hours a person logs land in their vault
  //           AssertionError: no daily note was ever written to the vault: expected false to be true
  //
  // NOT ASSERTED HERE, and it is worth saying why, because the plan names the string: the server's
  // `vault sync is idle: no vault folder is configured` line is a BOOT line, printed only when the
  // process starts up ALREADY `personal`. Under DD-024 the shape is answered after boot, so that
  // line can never print in this flow and an assertion that it did not is vacuous — it would pass
  // just as well with the vault step deleted. What the plan MEANT by it — the install is not idle —
  // is what the file below proves, and the sync engine's other half (reading a note the install did
  // not write) is the api case in tests/first-run-open.test.js, which found a real gap.
  it('the hours a person logs land in their vault', async () => {
    // Log an hour the way a person does — the day grid's add row, on Today. The install is fresh
    // and unseeded, so the row is the empty-day one with the format hint in it.
    await app.page.locator('text=Today').first().click();
    const add = app.page.locator('input[placeholder="12:00-13:00 · 5h…"]').first();
    await add.waitFor({ timeout: 15000 });
    await add.fill('09:00-10:00');
    await add.press('Enter');

    // THE PROOF IS THE FILE, not the JSON. `vaultPaths.root` being set says the setting stored;
    // only a daily note on disk says the install a person was sold is the install they got.
    const note = join(app.vaultDir, 'Calendar', 'Daily', todayISO() + '.md');
    const written = await until(() => existsSync(note) && readFileSync(note, 'utf8').includes('09:00'), {
      timeout: 30000,
    });
    expect(written, 'no daily note was ever written to the vault').toBe(true);
    expect(app.pageErrors).toEqual([]);
  }, 180000);

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. SB-153 REVERTED — `My company’s` restored as
  //   the option label while Settings → Vault kept saying `Team`, which is the disagreement the
  //   ruling closed and the one no unit assertion on a single string can see:
  //   2 fail, one in each file, and the pair is the point: a unit assertion on either string alone
  //   sees nothing wrong — the disagreement only exists BETWEEN the two screens.
  //     FAIL  the question and Settings → Vault call the same shape by the same name
  //           AssertionError: the first-run question and Settings → Vault name one value with two
  //           words: expected 'My company’s' to be 'Team' // Object.is equality
  //     FAIL  (onboarding-shape.test.js) a fresh install is asked, in shape words…
  //           AssertionError: expected 'Time Turtle\n\nWhose hours will this …' to contain 'Team'
  it('the question and Settings → Vault call the same shape by the same name', async () => {
    await app.page.locator('text=Settings').first().click();
    await app.page.locator('text=Vault').first().waitFor({ timeout: 15000 });
    // The shape toggle's own labels, read off the DOM of the OTHER surface. Two screens, one word.
    const settingsLabels = await app.page.evaluate(() => {
      const row = [...document.querySelectorAll('div')].find((d) => d.textContent.trim().startsWith('Instance shape'));
      return [...row.querySelectorAll('button')].map((b) => b.textContent.trim());
    });
    expect(settingsLabels).toContain('Team');
    expect(questionTeamLabel, 'the first-run question and Settings → Vault name one value with two words').toBe('Team');
    expect(app.pageErrors).toEqual([]);
  }, 120000);
});

// The registry-backed half of the vault step — the prefill and the pick-list. Every OTHER case in
// this file runs with no registry (the harness forces a path that does not exist, so nothing can
// read this machine's real vaults), which means without this case the easy path is the untested one
// — and it is the path Terje's own second machine takes, because his registry exists.
describe('DD-024 / SB-140: a machine that has Obsidian vaults registered', () => {
  let app = null;
  let vaults = null;
  beforeAll(async () => {
    // A FIXTURE, never `~/Library/Application Support/obsidian/obsidian.json`. Two vaults, and the
    // OPEN one is written second so the offered order cannot be insertion order by accident.
    const dir = mkdtempSync(join(tmpdir(), 'tt-browser-registry-'));
    vaults = { closed: join(dir, 'Ideaverse'), open: join(dir, 'ballestad') };
    mkdirSync(vaults.closed);
    mkdirSync(vaults.open);
    const registry = join(dir, 'obsidian.json');
    writeFileSync(
      registry,
      JSON.stringify({
        vaults: { a: { path: vaults.closed, ts: 2 }, b: { path: vaults.open, ts: 1, open: true } },
      }),
    );
    app = await startApp({ onboarding: true, obsidianRegistry: registry });
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  // ## Verified red-green: 2026-07-31, TRANSCRIBED. THE PREFILL DROPPED — `useState(info.vaults[0]
  //   ?.path ?? '')` weakened to `useState('')`, i.e. the registry read shipped and reached nobody,
  //   which is SB-063's shape and the reason SB-140 asked for a registry at all:
  //   1 of 7, and nothing else moves — every other case runs with no registry at all:
  //     FAIL  is offered them, with the one open in Obsidian already filled in
  //           AssertionError: the vault step made a person type a path Obsidian already knows:
  //           expected '' to be '/var/folders/qd/2zxnlvp14c994jtxqr34t…' // Object.is equality
  it('is offered them, with the one open in Obsidian already filled in', async () => {
    await app.page.locator('[data-tt="shape-choice-personal"]').click();
    const root = app.page.locator('[data-tt="first-run-vault-root"]');
    await root.waitFor({ timeout: 15000 });

    // PREFILLED, and with the OPEN vault rather than the most recently used one — `vaults[0]` is
    // the server's answer to "which one did you mean", and this is the rung that proves a person
    // sees it rather than that a route returned it.
    expect(await root.inputValue(), 'the vault step made a person type a path Obsidian already knows').toBe(
      vaults.open,
    );

    // Both are OFFERED, open first, and the filled one is the one marked as chosen.
    const options = app.page.locator('[data-tt="first-run-vault-option"]');
    expect(await options.count()).toBe(2);
    expect((await options.nth(0).innerText()).trim().split('\n')[0]).toBe('ballestad');
    expect((await options.nth(1).innerText()).trim().split('\n')[0]).toBe('Ideaverse');
    expect(await options.nth(0).getAttribute('aria-pressed')).toBe('true');

    // Picking the other one MOVES the field and the mark — a click that filled nothing visible
    // would leave a person unable to tell which vault they had chosen.
    await options.nth(1).click();
    await expect.poll(() => root.inputValue()).toBe(vaults.closed);
    expect(await options.nth(1).getAttribute('aria-pressed')).toBe('true');
    expect(await options.nth(0).getAttribute('aria-pressed')).toBe('false');

    // And it answers: the offered path is one the server accepts without editing.
    await app.page.locator('[data-tt="first-run-vault-submit"]').click();
    await app.page.locator('[data-tt="first-run"]').waitFor({ state: 'detached', timeout: 15000 });
    const state = await stateFromPage(app.page);
    expect(state.settings.vaultPaths.root).toBe(vaults.closed);
    expect(app.pageErrors).toEqual([]);
  }, 180000);
});

describe('DD-024 clause 2: the wall answering `Team` lands you on', () => {
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
  //   1 of 6, and nothing else moves:
  //     FAIL  a person who answers `Team` is told the password nobody ever showed them
  //           TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
  //           waiting for locator('[data-tt="login-default-credentials"]') to be visible
  //   THE GATE, mutated separately: `firstRunCaller`'s peer check dropped so the hint rides on the
  //   Host header alone — every case in THIS file stays green, because they all speak from
  //   loopback. That is why the LAN half and the retirement are api-rung cases (the DD-024 clause 2
  //   block in tests/first-run-open.test.js): this rung structurally cannot see either.
  it('a person who answers `Team` is told the password nobody ever showed them', async () => {
    await app.page.locator('[data-tt="shape-choice-team"]').click();
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
