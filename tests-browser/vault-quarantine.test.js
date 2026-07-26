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
// WHAT IT DOES NOT PROVE: that a quarantine is RESOLVABLE. It is not, by design, until SB-103 is
// ruled — there is deliberately no action here. Nor that the row is legible; that is the cropped
// screenshot in the task's report.
//
// ## Verified red-green: 2026-07-26
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
