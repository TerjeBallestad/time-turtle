// SB-102 / DD-017 §3 at the BROWSER rung — the whole user-visible half of this ticket.
//
// A green api test cannot see a chip. SB-063 is this repo's live example: it shipped
// `vaultTimeSeparator` with perfect plumbing, a passing suite and no UI at all, and
// `tests-browser/vault-quarantine.test.js`'s header says so in as many words. Everything asserted
// below is a thing that is or is not on a real screen, against the real built client.
//
// THE EVIDENCE IS THE CONTRAST, and the `team` half is the load-bearing one. Nearly every
// personal assertion here is an ABSENCE — no `open` chip, no `commit` verb, no chip row, no
// add-row — and an absence passes just as well when the view crashed, the page never loaded, or
// the selector was wrong. Only the SAME selectors finding those things one shape over
// distinguishes "the shape rule worked" from "the test lost the page". `startApp({ shape })`
// gives both halves off one build, one origin, one server binary.
//
// ## A NOTE ON THE SELECTORS, because it decides what the red run below is worth
//
// Everything the contrast rests on is TEXT a person reads — `open`, `commit`, the ruled string,
// the add-row placeholder. Those anchors exist in the pre-change build too, so the team half is
// green BEFORE and after, which is the only thing that makes the personal zeros meaningful.
//
// `data-tt="week-seg-row"` is the one structural anchor, and it is NEW. A zero from it on the
// pre-change build proves nothing (the row was there, it just had no attribute), so it is never
// the sole assertion in a case — the `open`-chip count is what actually goes red there.
//
// ## Verified red-green: 2026-07-27 (output TRANSCRIBED from the runs, not reconstructed)
//
//   (a) Built from the task-3 commit — WeekView.tsx, views.module.css and TimeGrid.tsx as they
//       stood before THIS task: the verbless `open` chip on every segment, the standing
//       `capabilityOff` line on every week, and no week-level mark. 3 of 4 fail:
//         x the current week offers no `open` chip and no `commit` verb
//           AssertionError: an `open` chip rendered under `personal`: expected 2 to be +0
//         x a week from before the vault says so once, and its grids offer no add-row
//           AssertionError: the `before your vault · read-only` line is not on the page:
//           expected 6 to be 1
//         x a week wholly after the vault with nothing committed renders no chip row at all
//           AssertionError: an `open` chip rendered on a post-vault personal week:
//           expected 1 to be +0
//         v the contrast: still shows the verbs and the `open` chips, and never the pre-vault mark
//       The 6 in the second one is not a typo and is worth reading: task 3 had already put the
//       ruled sentence on each locked DAY, so six copies were on screen and no week-level line
//       was. Seeing that in a screenshot is why the day banner now says only `read-only` and the
//       week says the sentence once — which is what DD-017 §3 asked for in the first place.
//
//   (b) THE CONTRAST CASE PASSES ON BOTH BUILDS. That is the whole reason it is here: it means
//       the three failures above are the shape rule being absent, not the page being absent.
//
//   (c) The inverse direction, on the finished build with `preVaultWeek` forced to `true` so the
//       mark renders in every shape — caught in both halves:
//         x a week wholly after the vault with nothing committed renders no chip row at all
//           AssertionError: the pre-vault mark rendered on a week wholly after the vault:
//           expected 1 to be +0
//         x still shows the verbs and the `open` chips, and never the pre-vault mark
//           AssertionError: the pre-vault mark leaked into the team shape: expected 1 to be +0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './harness.js';

const MARK = 'before your vault · read-only';

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
 * built bundle, so the labels are the only stable anchors — the same reasoning
 * personal-no-identity.test.js states.
 */
async function weekSurfaces(page) {
  return {
    markText: await page.locator(`text=${MARK}`).count(),
    chipRow: await page.locator('[data-tt="week-seg-row"]').count(),
    openChip: await page.getByText('open', { exact: true }).count(),
    // The per-day grid banner on a locked day. Exact, so it does not also match the week line's
    // `before your vault · read-only`, and not the `— reopen from the week header` variant either
    // (that hint is `team`'s and must never appear in a shape with no reopen verb).
    readOnlyHint: await page.getByText('read-only', { exact: true }).count(),
    reopenHint: await page.getByText('read-only — reopen from the week header', { exact: true }).count(),
    commitVerb: await page.locator('button:has-text("commit")').count(),
    // The add-row is the thing no test below this rung can see: a locked grid renders no NewRow,
    // so its input is simply not in the DOM. Both placeholders, because NewRow uses the long one
    // on an empty day and `+ add` on a day that already has rows.
    addRow: await page.locator('input[placeholder="+ add"], input[placeholder="12:00-13:00 · 5h…"]').count(),
  };
}

describe('DD-017 §3: a personal week that predates the vault', () => {
  /** @type {Awaited<ReturnType<typeof startApp>> | null} */
  let app = null;
  beforeAll(async () => {
    // A fresh `personal` install stamps its cutover at THIS boot (DD-016), so last week is wholly
    // before the vault and next week is wholly after it — no fixture needed, and no dependence on
    // a cutover of `''`, which would freeze nothing and let any build pass.
    app = await startApp({ shape: 'personal' });
    await gotoWeek(app.page);
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  it('the current week offers no `open` chip and no `commit` verb', async () => {
    // `open` means "you may commit this". Committing is off in this shape, so the word is a claim
    // the install cannot honour — and DD-017 §3 rules it off the screen rather than greyed out.
    const week = await weekSurfaces(app.page);
    expect(week.openChip, 'an `open` chip rendered under `personal`').toBe(0);
    expect(week.commitVerb, 'a `commit` verb rendered under `personal`').toBe(0);
    // THE POSITIVE CONTROL for this whole describe: today's grid is after the vault and therefore
    // editable, so the view is demonstrably rendering and the zeros above are not an empty page.
    expect(week.addRow, 'today’s own grid had no add-row — is the Week view rendering at all?').toBeGreaterThan(0);
    expect(app.pageErrors, 'the page threw').toEqual([]);
  }, 120000);

  it('a week from before the vault says so once, and its grids offer no add-row', async () => {
    await stepWeek(app.page, '‹');
    const week = await weekSurfaces(app.page);
    // ONE line — not one per day, not one per segment. DD-017 §3 says once, and saying it per
    // day put the same sentence on screen seven times when it was looked at.
    expect(week.markText, 'the `before your vault · read-only` line is not on the page').toBe(1);
    // The days themselves are marked, and marked with the shape's OWN hint: a personal week
    // header has no reopen verb, so the `team` hint pointing at one must not be here.
    expect(week.readOnlyHint, 'no locked day was marked read-only').toBeGreaterThan(0);
    expect(week.reopenHint, 'a personal grid told the user to reopen from a header with no verb').toBe(0);
    // …and the grids beneath it are genuinely locked. THIS is the assertion that cannot be made
    // below the browser: a green api test cannot see an input that is absent.
    //
    // CASE A, asserted rather than assumed. The week the nav lands on is the one BEFORE today, so
    // its days are all in the past — but `vaultCutover` is stamped as a UTC instant while
    // `Entry.date` is a local day (SB-147), so on the one weekday where last week's Sunday IS the
    // cutover day, that Sunday is editable and keeps its add-row. That is the straddling week
    // DD-017's mock does not cover, working: the line renders because SOME day qualifies, and the
    // per-day truth is each grid's own banner. So the invariant is not "no add-rows" — it is that
    // every one of the seven days is EITHER marked read-only OR editable, never both and never
    // neither, and at most one of them can fall the editable side.
    expect(week.readOnlyHint + week.addRow, 'a day was neither marked read-only nor editable').toBe(7);
    expect(week.addRow, 'more than one day of a week before the vault was still editable').toBeLessThanOrEqual(1);
    expect(week.readOnlyHint, 'a week before the vault locked fewer than six of its days').toBeGreaterThanOrEqual(6);
    expect(app.pageErrors, 'the page threw').toEqual([]);
  }, 120000);

  it('a week wholly after the vault with nothing committed renders no chip row at all', async () => {
    await stepWeek(app.page, '›'); // back to the current week
    await stepWeek(app.page, '›'); // and on to one that is wholly after the cutover
    const week = await weekSurfaces(app.page);
    // The chip that WOULD have rendered here before this change, and the one that carries the
    // red: the structural anchor below cannot go red on a build that never had it.
    expect(week.openChip, 'an `open` chip rendered on a post-vault personal week').toBe(0);
    // Not an empty row and not reserved space — absent.
    expect(week.chipRow, 'the chip row rendered with nothing to say').toBe(0);
    expect(week.markText, 'the pre-vault mark rendered on a week wholly after the vault').toBe(0);
    expect(app.pageErrors, 'the page threw').toEqual([]);
  }, 120000);
});

describe('the contrast: the SAME build against a `team` data dir', () => {
  /** @type {Awaited<ReturnType<typeof startApp>> | null} */
  let app = null;
  beforeAll(async () => {
    app = await startApp({ shape: 'team' });
  }, 120000);
  afterAll(async () => {
    await stopApp(app);
  });

  it('still shows the verbs and the `open` chips, and never the pre-vault mark', async () => {
    // THE HALF THAT MAKES THE OTHER ONE MEAN SOMETHING. Same selectors, same build, one shape
    // over: if these found nothing either, the personal zeros above were the test losing the page.
    await gotoWeek(app.page);
    const now = await weekSurfaces(app.page);
    expect(now.openChip, 'no `open` chip under `team`').toBeGreaterThan(0);
    expect(now.commitVerb, 'no `commit` verb under `team`').toBeGreaterThan(0);
    expect(now.addRow, 'no add-row under `team`').toBeGreaterThan(0);
    expect(now.markText, 'the pre-vault mark leaked into the team shape').toBe(0);

    // and a week in the past is still ordinary under `team` — there is no vault to predate, so
    // its grids stay editable and its chips stay committable
    await stepWeek(app.page, '‹');
    const past = await weekSurfaces(app.page);
    expect(past.markText, 'the pre-vault mark leaked into a past team week').toBe(0);
    expect(past.openChip, 'a past team week lost its `open` chip').toBeGreaterThan(0);
    expect(past.addRow, 'a past team week lost its add-row').toBeGreaterThan(0);
    expect(app.pageErrors, 'the page threw').toEqual([]);
  }, 120000);
});
