// SB-067's owed browser debt, paid: a keystroke in the UI has to come out the other end as
// bytes in the markdown mirror.
//
// Add a client, type its name, blur — blur is the deliberate commit boundary where the id is
// derived (App.commitClientName → derivedClientId) — and the mirror on DISK must read
// `- ballestad-studios | Ballestad Studios`.
//
// The api rung can prove the endpoint writes the mirror. It cannot prove that the blur on that
// particular input is wired to the derive at all; a name typed into a field that never commits
// produces a perfectly valid mirror with a `client3` in it.
//
// ## Verified red-green: 2026-07-26
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, readClientRows, clientsBlock, until } from './harness.js';

let app;

beforeAll(async () => {
  app = await startApp();
}, 90000);

afterAll(async () => {
  await stopApp(app);
});

describe('the client-name commit boundary', () => {
  it('writes the derived id into the markdown mirror on disk', async () => {
    const { page, mdDir } = app;

    await page.locator('button:has-text("+ client")').first().click();
    await until(async () => (await readClientRows(page)).some((row) => /^client\d+$/.test(row.id)));
    const rows = await readClientRows(page);
    const fresh = rows.find((row) => /^client\d+$/.test(row.id));
    expect(fresh, `expected a freshly minted client row, got ${JSON.stringify(rows)}`).toBeTruthy();

    const name = page.locator(`[data-tt="c${fresh.i}-name"]`);
    await name.fill('Ballestad Studios');
    await name.press('Tab'); // blur — the commit boundary

    const landed = await until(() => clientsBlock(mdDir).includes('- ballestad-studios | Ballestad Studios'), {
      timeout: 20000,
    });
    expect(landed, `mirror ## clients block was:\n${clientsBlock(mdDir)}`).toBe(true);

    // The minted placeholder id must not survive alongside it — the derive renames the row,
    // it does not add a second one.
    expect(clientsBlock(mdDir)).not.toContain(`- ${fresh.id} |`);
  }, 90000);
});
