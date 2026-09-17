// SB-067's owed browser debt, paid: a keystroke in the UI has to come out the other end as the id
// the server stores.
//
// Add a client, type its name, blur — blur is the deliberate commit boundary where the id is
// derived (App.commitClientName → derivedClientId) — and a fresh `GET /api/state` from the page's
// own session must carry `ballestad-studios`.
//
// The api rung can prove the endpoint stores what it is sent. It cannot prove that the blur on that
// particular input is wired to the derive at all; a name typed into a field that never commits
// stores a perfectly valid catalog with a `client3` in it.
//
// Moved from mirror-bytes.test.js when the markdown mirror was removed (SB-181): the claim is the
// same, and it is now read back through the API instead of off a file on disk.
//
// ## Verified red-green: 2026-09-17 — the API read-back oracle is this file's own, so it was
// re-verified rather than transcribed: `commitClientName` made a no-op, and the test fails with
// the stored catalog carrying `client3` instead of `ballestad-studios`. Earlier red-green on the
// same claim: 2026-07-26 (as `writes the derived id into the markdown mirror on disk`).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, readClientRows, until } from './harness.js';

let app;

beforeAll(async () => {
  app = await startApp();
}, 90000);

afterAll(async () => {
  await stopApp(app);
});

/** The stored clients, read back through the page's own session. */
const storedClients = (page) => page.evaluate(() => fetch('/api/state').then((r) => r.json().then((s) => s.clients)));

describe('the client-name commit boundary', () => {
  it('the derived id is what the server stores after the name field blurs', async () => {
    const { page } = app;

    await page.locator('button:has-text("+ client")').first().click();
    await until(async () => (await readClientRows(page)).some((row) => /^client\d+$/.test(row.id)));
    const rows = await readClientRows(page);
    const fresh = rows.find((row) => /^client\d+$/.test(row.id));
    expect(fresh, `expected a freshly minted client row, got ${JSON.stringify(rows)}`).toBeTruthy();

    const name = page.locator(`[data-tt="c${fresh.i}-name"]`);
    await name.fill('Ballestad Studios');
    await name.press('Tab'); // blur — the commit boundary

    const landed = await until(
      async () =>
        (await storedClients(page)).some((c) => c.id === 'ballestad-studios' && c.name === 'Ballestad Studios'),
      { timeout: 20000 },
    );
    expect(landed, `stored clients were:\n${JSON.stringify(await storedClients(page))}`).toBe(true);

    // The minted placeholder id must not survive alongside it — the derive renames the row,
    // it does not add a second one.
    expect((await storedClients(page)).some((c) => c.id === fresh.id)).toBe(false);
  }, 90000);
});
