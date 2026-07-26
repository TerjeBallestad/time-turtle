// SB-134: the sidebar's sync line may only claim a write that is actually happening.
//
// Under `personal` the v2 markdown mirror is off by construction (DD-011 retires it, DD-015/SB-100
// derive the `vault` backend), and the line still read `synced → md` — a STATUS INDICATOR making a
// positive claim about a write that does not occur. A green unit test cannot catch that, because
// the defect is entirely in what a person reads on screen: this is a rendering claim, so it is
// judged at the browser rung or not at all. SB-063 is this repo's own example of the alternative.
//
// TWO SERVERS, ON PURPOSE, and the `team` half is the control that matters as much as the
// `personal` half: a single instance reading `synced → vault` would prove only that a string was
// changed, not that the label FOLLOWS THE SHAPE. The scope note on SB-134 is explicit that
// `team`'s `synced → md` is true and must stay byte-identical, so the regression this file has to
// be able to catch is "someone made every install say vault".
//
// WHAT IT DOES NOT PROVE: that the line is legible at 10–13 px (that is a screenshot's verdict, and
// the pinned sidebar-bottom is the known screenshot-capture quirk — this reads the DOM instead),
// that the Norwegian reads naturally to a Norwegian, or that a vault write SUCCEEDED. `synced →
// vault` claims the save reached the store that this shape derives; the quarantine case below is
// the counter-state, and it is the one that makes the claim falsifiable rather than decorative.
//
// ## Verified red-green: 2026-07-27
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, stopApp, until } from './harness.js';

let team;
let personal;

beforeAll(async () => {
  [team, personal] = await Promise.all([startApp(), startApp({ shape: 'personal' })]);
}, 120000);

afterAll(async () => {
  await Promise.all([stopApp(team), stopApp(personal)]);
});

/** What the pinned sidebar sync row actually SHOWS — read off the DOM, not off the store. */
async function syncText(page) {
  const row = page.locator('[data-tt="sync-status"]');
  await row.waitFor({ timeout: 20000 });
  return (await row.innerText()).trim();
}

describe('the sidebar sync line under `team` (the control)', () => {
  it('still reads `synced → md`, because there the mirror is real', async () => {
    expect(await syncText(team.page)).toBe('synced → md');
    expect(team.pageErrors).toEqual([]);
  }, 60000);
});

describe('the sidebar sync line under `personal`', () => {
  it('makes no markdown-mirror claim, and names the vault instead', async () => {
    const text = await syncText(personal.page);
    // the defect, stated as the assertion: no mirror claim where no mirror byte is written
    expect(text).not.toContain('md');
    expect(text).toBe('synced → vault');
    expect(personal.pageErrors).toEqual([]);
  }, 60000);

  it('reads the REAL vault state — a quarantined note turns the line into `Notes paused`', async () => {
    const { page, vaultDir } = personal;
    const daily = join(vaultDir, 'Calendar', 'Daily');
    mkdirSync(daily, { recursive: true });

    // A note TT will refuse: the heading is there, and under it is a sentence rather than a table.
    // vault-quarantine.test.js's note, deliberately — one shape of refusal, proven once.
    const date = '2099-02-11'; // after any cutover this install could have stamped
    writeFileSync(
      join(daily, date + '.md'),
      `# ${date}\n\n## Intentions\n\nplans\n\n## Time Log\n\nI wrote about my morning here instead of logging it.\n\n\`revision: 4 · abcd\`\n\n## Captures\n\nthoughts\n`,
    );

    // Point the app at the vault through the UI's own field, as a person would. The path rides the
    // client's 700 ms debounce, so wait for the SERVER to hold the quarantine before reloading —
    // reloading straight after the keystroke races the PUT and the vault is never configured.
    await setVaultRoot(page, vaultDir);
    const recorded = await until(
      async () => {
        const st = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
        return (st.vaultQuarantined || []).length > 0;
      },
      { timeout: 30000 },
    );
    expect(recorded, 'the server never recorded a quarantine for the note').toBe(true);

    // `vaultQuarantined` rides `/api/state`, so it lands on the next LOAD (the save response
    // carries it too, but adopting it live means editing useServerSync — SB-118's under DD-019).
    await page.reload();
    const text = await syncText(page);
    expect(text).not.toContain('md');

    // THE COUNT IS THE SERVER'S, not a second derivation — that is the whole "reuse TASK-054's
    // state" requirement, and comparing against /api/state is how a divergence would show.
    const server = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
    expect(text).toBe(`Notes paused (${server.vaultQuarantined.length})`);
    // one phrase, two places: the sidebar and the panel that explains it
    await page.locator('text=Settings').first().click();
    const panel = page.locator('[data-tt="vault-quarantined"]');
    await panel.waitFor({ timeout: 20000 });
    expect(await panel.innerText()).toContain('Notes paused');
    expect(personal.pageErrors).toEqual([]);
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
