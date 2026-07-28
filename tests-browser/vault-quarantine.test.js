// SB-057 task 8's browser debt: a person opening Settings SEES which note stopped syncing and why.
//
// An api test asserting `vaultQuarantined` is in the JSON is "an api test wearing a DOM" — it
// cannot prove anything renders. SB-063 is this repo's own example of what that failure looks
// like: perfect plumbing, a green api test, and a setting nobody could reach from the app. And a
// quarantine that is only in the JSON is worse than that, because the whole POINT of the state is
// that a person is told.
//
// Committed as a Playwright case rather than left as a screenshot because it has a definite
// pass/fail a machine can state, and — unlike an observation — it can go red later.
//
// WHAT THE FIRST CASE DOES NOT PROVE: that a quarantine is legible; that is the cropped screenshot
// in the task's report. It used to say "nor that it is resolvable — it is not, by design, until
// SB-103 is ruled". SB-103 WAS ruled (DD-021, widened by DD-022) and SB-127 built the gesture, so
// the second describe below is that claim, at the rung the ticket names. The first case's
// `no button` assertion is not obsolete and was not weakened: DD-021 consequence 4 is that every
// reason OTHER than the three admitting ones renders with no action control at all, and `no-table`
// is one of those. It went from "nothing is offered yet" to "nothing is offered here", which is a
// stronger claim about the same bytes.
//
// ## Verified red-green: 2026-07-26 (the refusal row) · 2026-07-28 (the adopt gesture)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import TT from '../shared/core.js';
import { startApp, stopApp, until } from './harness.js';

let app;

beforeAll(async () => {
  app = await startApp({ shape: 'personal' });
}, 90000);

afterAll(async () => {
  await stopApp(app);
});

describe('a quarantined daily note', () => {
  it('is a row in Settings → Vault, naming the note and why it is paused', async () => {
    const { page, vaultDir } = app;
    const daily = join(vaultDir, 'Calendar', 'Daily');
    mkdirSync(daily, { recursive: true });

    // A note TT will refuse: the heading is there, and under it is a sentence rather than a table.
    // A REAL shape — this is what a daily note looks like when you write about your morning
    // instead of logging it.
    const date = '2099-01-15'; // after any cutover this install could have stamped
    const notePath = join(daily, date + '.md');
    writeFileSync(
      notePath,
      `# ${date}\n\n## Intentions\n\nplans\n\n## Time Log\n\nI wrote about my morning here instead of logging it.\n\n\`revision: 4 · abcd\`\n\n## Captures\n\nthoughts\n`,
    );

    // Point the app at the vault through the UI's own path field, so the row under test is
    // reached the way a person reaches it.
    await page.locator('text=Vault').first().waitFor({ timeout: 20000 });
    const rootInput = page
      .locator('input')
      .filter({ hasNot: page.locator('x') })
      .nth(0);
    void rootInput; // (the field is located by label below — this keeps the intent readable)
    await setVaultRoot(page, vaultDir);

    // Wait for the SERVER to have the quarantine before reloading. The path is saved through the
    // client's own 700 ms debounce, so reloading straight after the keystroke races it — the PUT
    // never leaves, and the vault is never configured.
    const recorded = await until(
      async () => {
        const st = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
        return (st.vaultQuarantined || []).length > 0;
      },
      { timeout: 30000 },
    );
    expect(recorded, 'the server never recorded a quarantine for the note').toBe(true);

    // The row is read off `/api/state`, so it lands on the next LOAD. The save response carries
    // `vaultQuarantined` too (server side, per SB-085's precedent), but adopting it live means
    // editing `useServerSync`, which is SB-118's under DD-019 and deliberately untouched here.
    // What is claimed at this rung is the thing that matters: a person who opens Settings sees it.
    await page.reload();
    await page.locator('text=Settings').first().waitFor({ timeout: 20000 });
    await page.locator('text=Settings').first().click();

    const visible = await until(async () => (await page.locator('[data-tt="vault-quarantined"]').count()) > 0, {
      timeout: 30000,
    });
    expect(visible, 'no quarantine row ever appeared in Settings → Vault').toBe(true);

    const panel = page.locator('[data-tt="vault-quarantined"]');
    const text = await panel.innerText();
    // the PATH, so a person knows which note to open
    expect(text).toContain(notePath);
    expect(text).toContain(date);
    // the headline — and it must never claim the hours were corrupted
    expect(text).toContain('cannot prove it wrote this block');
    expect(text.toLowerCase()).not.toContain('corrupt');
    // the reason, in words. `no-table` and not `unexpected-content-in-block`: the locator looks for
    // a table header first and there is none, which is the verdict a human gets for this note.
    expect(text).toContain('there is no table under the heading.');
    // and NO resolution action: SB-103 rules that, and shipping a button here would rule it early
    expect(await panel.locator('button').count()).toBe(0);

    // STICKY, not a toast: it is still there on the NEXT reload too, and on the one after that —
    // a toast would have gone by now.
    await page.reload();
    await page.locator('text=Settings').first().waitFor({ timeout: 20000 });
    await page.locator('text=Settings').first().click();
    const stillThere = await until(async () => (await page.locator('[data-tt="vault-quarantined"]').count()) > 0, {
      timeout: 20000,
    });
    expect(stillThere, 'the quarantine row did not survive a reload — it is a toast, not state').toBe(true);

    // and TT really did leave the note alone
    expect(readFileSync(notePath, 'utf8')).toContain('I wrote about my morning here instead of logging it.');
    expect(app.pageErrors).toEqual([]);
  }, 120000);
});

// SB-127 / DD-021 + DD-022 — a person can ACT on a paused note.
//
// THIS IS THE CLAIM THE api RUNG CANNOT MAKE. tests/vault-adopt.test.js proves the endpoint takes
// the note's rows, states the delta and re-anchors above the index — every byte of that can be
// true while the button is unreachable, mislabelled, or wired to nothing, which is exactly the
// failure SB-063 is this repo's standing example of. What is proved here is narrower and is the
// point of the whole ticket: the row states its price, the button is there, the lossy one asks
// first, and pressing it un-pauses the day.
//
// A SEPARATE APP INSTANCE from the case above, because the case above asserts that the panel holds
// NO button — one adoptable note anywhere in that panel would make it pass or fail for the wrong
// reason. Two situations, two installs.
describe('adopting a paused note from Settings', () => {
  let own;
  beforeAll(async () => {
    own = await startApp({ shape: 'personal' });
  }, 90000);
  afterAll(async () => {
    await stopApp(own);
  });

  it('states the cost, asks once, and gives the day back', async () => {
    const { page, vaultDir } = own;
    const daily = join(vaultDir, 'Calendar', 'Daily');
    mkdirSync(daily, { recursive: true });
    const date = '2099-02-11'; // after any cutover this install could have stamped
    const notePath = join(daily, date + '.md');
    const row = (label, start, end) => ({
      id: 'x-' + label,
      date,
      start,
      end,
      durMin: null,
      project: null,
      label,
      note: '',
      billable: true,
    });
    /** A whole daily note, TT's own bytes, signed — everything outside the block is Terje's. */
    const note = (entries, revision) =>
      `# ${date}\n\n## Intentions\n\nplans\n\n` +
      TT.serializeVaultBlock(entries, { heading: 'Time Log', revision }) +
      '\n\n## Captures\n\nthoughts\n';

    // 1. A note Time Turtle is happy with, so it IMPORTS the row and its index has something to
    //    lose. Without this the delta is `0 · 1`, the adopt is free, and the confirm — the half
    //    that matters — is never reached.
    writeFileSync(notePath, note([row('the morning', 540, 600)], 3));
    await page.locator('text=Vault').first().waitFor({ timeout: 20000 });
    await setVaultRoot(page, vaultDir);
    const imported = await until(
      async () => {
        const st = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
        return (st.entries || []).some((e) => e.date === date);
      },
      { timeout: 30000 },
    );
    expect(imported, 'Time Turtle never imported the note, so there is nothing to drop').toBe(true);

    // 2. Now the note says something ELSE, under an anchor that still describes the old bytes.
    //    Terje's gesture: he typed into the table. One row each side, and they disagree.
    writeFileSync(notePath, note([row('the morning', 540, 600)], 3).replace('| 09:00→10:00', '| 09:00→14:30'));
    const stuck = await until(
      async () => {
        const st = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
        return (st.vaultQuarantined || []).some((n) => n.date === date);
      },
      { timeout: 30000 },
    );
    expect(stuck, 'the note never paused, so there is nothing to adopt').toBe(true);

    await page.reload();
    await page.locator('text=Settings').first().waitFor({ timeout: 20000 });
    await page.locator('text=Settings').first().click();
    const panel = page.locator('[data-tt="vault-quarantined"]');
    expect(await until(async () => (await panel.count()) > 0, { timeout: 30000 })).toBe(true);

    // THE COUNTS ARE ON THE ROW, always — DD-021. One and one, and yet not free, which is the
    // whole reason `dropped` compares content and not length (DD-022 rider 1).
    const text = await panel.innerText();
    expect(text).toContain('Time Turtle holds 1 entry · the note has 1.');
    expect(text).toContain('cannot prove it wrote this block');
    expect(text.toLowerCase()).not.toContain('corrupt');

    // THE BUTTON NAMES THE NUMBER rather than asking blandly.
    const adopt = panel.locator('[data-tt="vault-adopt"]');
    expect(await adopt.count()).toBe(1);
    expect(await adopt.innerText()).toContain('1 entry will be dropped');

    // …AND ASKS ONCE. The first press is not the act: it opens the confirm, which says out loud
    // what is lost and that the NOTE is not what loses it.
    await adopt.click();
    const confirm = panel.locator('[data-tt="vault-adopt-confirm"]');
    await confirm.waitFor({ timeout: 10000 });
    const asked = await panel.innerText();
    expect(asked).toContain('adopting drops it');
    expect(asked).toContain('Nothing in the note is removed');

    // Cancelling really cancels — the day is still paused and the note is byte-identical.
    const bytes = readFileSync(notePath, 'utf8');
    await panel.locator('text=cancel').first().click();
    await page.waitForTimeout(300);
    expect(await panel.locator('[data-tt="vault-adopt-confirm"]').count()).toBe(0);
    expect(readFileSync(notePath, 'utf8')).toBe(bytes);

    // 3. Through it this time. The client reloads on success, so the panel is re-read from a
    //    fresh page rather than from state this test patched.
    await panel.locator('[data-tt="vault-adopt"]').click();
    await panel.locator('[data-tt="vault-adopt-confirm"]').click();
    await page.locator('text=Settings').first().waitFor({ timeout: 20000 });
    await page.locator('text=Settings').first().click();
    const cleared = await until(async () => (await page.locator('[data-tt="vault-quarantined"]').count()) === 0, {
      timeout: 30000,
    });
    expect(cleared, 'the paused row is still on screen after adopting').toBe(true);

    // and the day really did come back: the NOTE's hours won, and Time Turtle vouches for the
    // note again rather than merely having stopped complaining about it
    const after = TT.parseVaultBlock(readFileSync(notePath, 'utf8'), { heading: 'Time Log', date });
    expect(after.quarantine).toBe(false);
    expect(after.verified).toBe(true);
    expect(after.entries[0].end).toBe(870); // 14:30 — what the note said, not what TT held
    expect(after.revision).toBeGreaterThan(3);
    const st = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
    expect(st.entries.filter((e) => e.date === date).map((e) => e.end)).toEqual([870]);
    expect(own.pageErrors).toEqual([]);
  }, 180000);
});

/** Type the vault root into the "Vault folder" field and commit it with a blur, as a person would. */
async function setVaultRoot(page, root) {
  const field = page
    .locator('div')
    .filter({ hasText: /^Vault folder/ })
    .locator('input')
    .last();
  await field.waitFor({ timeout: 20000 });
  await field.fill(root);
  await field.press('Enter');
}
