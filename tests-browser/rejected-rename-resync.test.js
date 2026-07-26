// The defect that motivated DD-013, and the first thing on this rung that can go red.
//
// A rename the server REFUSES (409, id already in use) must leave the id field showing the
// STORED id, not the refused one. `ClientIdInput` resyncs through `useEffect(() => setValue(id),
// [id])`, which only fires when the prop changes — and a rejection changes nothing. Without the
// `setValue(id)` inside `commit`, the store is right and the control lies.
//
// Nothing below the browser can see this. The api rung gets a correct 409; the unit rung gets a
// correct reducer; the build rung gets a clean bundle. Only a rendered input can be caught
// displaying a value the server never accepted.
//
// ## Verified red-green: 2026-07-26
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, readClientRows, until } from './harness.js';

let app;

beforeAll(async () => {
  app = await startApp();
}, 90000);

afterAll(async () => {
  await stopApp(app);
});

describe('a rejected client rename', () => {
  it('leaves the id field showing the stored id, not the refused one', async () => {
    const { page } = app;

    // The seed ships two clients, both referenced by projects: `fjellheim` and `brygga`.
    const before = await readClientRows(page);
    const brygga = before.find((row) => row.id === 'brygga');
    const fjellheim = before.find((row) => row.id === 'fjellheim');
    expect(brygga, `expected a 'brygga' row, got ${JSON.stringify(before)}`).toBeTruthy();
    expect(fjellheim, `expected a 'fjellheim' row, got ${JSON.stringify(before)}`).toBeTruthy();

    // Ask for an id that is already taken. Enter is the commit boundary.
    const field = page.locator(`[data-tt="c${brygga.i}-id"]`);
    await field.fill('fjellheim');
    await field.press('Enter');

    // The server really refused — without this the test would also pass if the commit had
    // silently never fired, which would prove nothing about the resync.
    const refused = await until(async () => (await page.locator('body').innerText()).includes('already in use'));
    expect(refused, 'expected a toast saying the id is already in use').toBe(true);

    // The verdict: what the CONTROL displays, read off the DOM node.
    const after = await readClientRows(page);
    const bryggaRow = after.find((row) => row.name === 'Brygga Digital');
    expect(bryggaRow, `the Brygga Digital row disappeared: ${JSON.stringify(after)}`).toBeTruthy();
    expect(bryggaRow.id).toBe('brygga');

    // And exactly one row still claims `fjellheim` — the one that always had it.
    expect(after.filter((row) => row.id === 'fjellheim')).toHaveLength(1);
  }, 60000);
});
