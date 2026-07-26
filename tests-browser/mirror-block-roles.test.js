// SB-095 — the mirror-refusal surface, proven from the SESSIONS that own the claim.
//
// SB-085 built the notice and the adopt action, but put them inside `MarkdownSection`, which
// is admin-only. So the two defects this file pins are both about WHO is looking:
//
//   1. a non-admin whose OWN mirror is blocked had no way out of it at all — only a toast
//      flying past on each save;
//   2. an admin could not see or clear an EMPLOYEE's block, even though
//      `POST /api/mirror/acknowledge` has taken `{userId}` since SB-065. The write was built
//      and unreachable; `GET /api/mirror/blocks` is the read that reaches it.
//
// Why the browser rung and not api: every assertion here is about what a session can REACH.
// A 200 from `/api/mirror/acknowledge` is exactly the fake evidence — it proves the server
// would clear a block for anyone who asked, which was already true before this ticket and is
// the reason the ticket exists. The claim is that an employee can get to the affordance, so
// the employee's own browser session is the only thing that can carry it.
//
// Everything destructive is still asserted against BYTES ON DISK: adopting is consent, not a
// write, and the file must stay foreign until the next real save.
//
// ## Verified red-green: 2026-07-26
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { startApp, stopApp, loginAs, until, ADMIN_EMAIL, ADMIN_PASSWORD } from './harness.js';
import { session } from '../tests/util.js';

const EMP_EMAIL = 'ella@timeturtle.local';
const EMP_PASSWORD = 'ellapw123';
const EMP_NAME = 'Ella Employee';

// What a second machine (or a human in Obsidian) leaves behind. Deliberately not valid mirror
// content: if TT ever writes over it, the difference is unmissable.
const foreign = (tag) => `# NOT WRITTEN BY TIME TURTLE\n\n${tag}\n`;

let app;
/** cookie-jar sessions used ONLY to set up and to interrogate the server, never to act for a user */
let adminApi;
let empApi;
let empMirror;
let adminMirror;
/** the employee session — created once and kept, because "still logged in as an employee" is the point */
let emp;

const entry = (note) => ({
  id: 'sb95-' + note.replace(/\W+/g, '-'),
  date: '2026-07-26',
  start: '09:00',
  end: '10:00',
  durMin: 60,
  project: null,
  label: 'Mirror',
  note,
  billable: true,
});

/**
 * Every mirror-block notice heading currently on the page, read off the DOM.
 *
 * A count, not a boolean: "the admin's own block moved to the new row and is NOT rendered
 * twice" is a claim about how many, and the old placement rendered it under the Mirror folder
 * input as well. CSS-module class names are hashed in the built bundle, so the heading text
 * is the stable anchor.
 */
const noticeTitles = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('span')]
      .map((s) => s.textContent.trim())
      .filter((t) => t.startsWith('Mirror paused')),
  );

/** The whole Settings view as text, for "is it reachable" assertions and for failure output. */
const settingsText = (page) => page.evaluate(() => document.body.innerText);

async function openSettings(page) {
  await page.locator('text=Settings').first().click();
  await page.locator('text=Language').first().waitFor({ timeout: 15000 });
}

/** Drive the two-step adopt on the only notice on screen, and wait for the row to go. */
async function adopt(page) {
  await page.locator('button:has-text("Adopt the file on disk")').click();
  await page.locator('button:has-text("Adopt it and overwrite on the next save")').click();
}

beforeAll(async () => {
  app = await startApp();

  adminApi = session(app.port);
  expect((await adminApi('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).status).toBe(
    200,
  );
  const created = await adminApi('POST', '/api/users', {
    email: EMP_EMAIL,
    name: EMP_NAME,
    role: 'employee',
    password: EMP_PASSWORD,
  });
  expect(created.status).toBe(200);
  expect(created.json.user.role).toBe('employee');

  empApi = session(app.port);
  expect((await empApi('POST', '/api/auth/login', { email: EMP_EMAIL, password: EMP_PASSWORD })).status).toBe(200);

  // The employee's mirror: written once (so TT has stamped it), then changed underneath by
  // "another machine", then written again — which is the refusal.
  const first = await empApi('PUT', '/api/state', { entries: [entry('before')] });
  empMirror = first.json.mirror;
  expect(
    empMirror,
    `expected the employee's first save to write a mirror, got ${JSON.stringify(first.json)}`,
  ).toBeTruthy();
  writeFileSync(empMirror, foreign('the employee copy'), 'utf8');
  const second = await empApi('PUT', '/api/state', { entries: [entry('blocked')] });
  expect(second.json.mirrorBlocked, 'the employee mirror should be blocked before the UI is even opened').toBeTruthy();

  adminMirror = (await adminApi('PUT', '/api/state', { entries: [entry('admin before')] })).json.mirror;
  expect(adminMirror).toBeTruthy();
}, 120000);

afterAll(async () => {
  await stopApp(app);
});

describe('a blocked mirror, from the session that owns it', () => {
  it('an EMPLOYEE can reach the notice and clear it — the whole of defect 1', async () => {
    emp = await loginAs(app, EMP_EMAIL, EMP_PASSWORD);
    const empPage = emp.page;
    await openSettings(empPage);
    await until(async () => (await noticeTitles(empPage)).length > 0);

    // 1. it is ON SCREEN in a non-admin session — no devtools, no admin page
    const text = await settingsText(empPage);
    expect(await noticeTitles(empPage), `employee Settings read:\n${text}`).toEqual(['Mirror paused']);
    expect(text).toContain(empMirror);
    expect(text).toContain('the file changed on disk since Time Turtle last wrote it');

    // 2. and the ADMIN-only half is still admin-only in that same session: the mirror FOLDER
    //    decides where everyone's files are written, and an employee does not get that input.
    //    (Case-insensitive because `SectionLabel` uppercases through CSS, and `innerText`
    //    reports what is PAINTED — a plain `toContain('Markdown mirror')` here would be a
    //    passing assertion that proves nothing.)
    expect(text).not.toMatch(/Mirror folder/i);
    expect(text).not.toMatch(/Markdown mirror/i);

    // 3. the adopt action actually works FROM HERE
    await adopt(empPage);
    const cleared = await until(async () => (await empApi('GET', '/api/state')).json.mirrorBlocked === null);
    expect(cleared, 'the employee adopting in the UI should clear the block server-side').toBe(true);
    expect(await until(async () => (await noticeTitles(empPage)).length === 0)).toBe(true);

    // 4. …and it was CONSENT, not a write: the other machine's bytes are still on disk
    expect(readFileSync(empMirror, 'utf8')).toBe(foreign('the employee copy'));

    // 5. the next save is what overwrites it — the mirror is genuinely unstuck, not just quiet
    const after = await empApi('PUT', '/api/state', { entries: [entry('after adopt')] });
    expect(after.json.mirrorError).toBe(null);
    expect(readFileSync(empMirror, 'utf8')).toContain('after adopt');
  }, 120000);

  it('an ADMIN can see and clear that employee’s block — the whole of defect 2', async () => {
    // block it again, out of band, exactly as before
    writeFileSync(empMirror, foreign('the second employee copy'), 'utf8');
    expect((await empApi('PUT', '/api/state', { entries: [entry('reblocked')] })).json.mirrorBlocked).toBeTruthy();
    // the admin's own mirror is fine at this point — so anything on screen is somebody else's
    expect((await adminApi('GET', '/api/state')).json.mirrorBlocked).toBe(null);

    await app.page.reload();
    await openSettings(app.page);
    // the admin's list is a FETCH (`GET /api/mirror/blocks`), not part of /api/state — so wait
    // for it rather than assuming it resolved before the click on Settings did
    await until(async () => (await noticeTitles(app.page)).length > 0);

    const text = await settingsText(app.page);
    expect(await noticeTitles(app.page), `admin Settings read:\n${text}`).toEqual([`Mirror paused for ${EMP_NAME}`]);
    expect(text).toContain(empMirror);

    await adopt(app.page);
    const cleared = await until(async () => (await empApi('GET', '/api/state')).json.mirrorBlocked === null);
    expect(cleared, 'the admin adopting the employee’s file should clear THEIR block').toBe(true);
    expect(await until(async () => (await noticeTitles(app.page)).length === 0)).toBe(true);
    // still consent, not a write — an admin clearing someone else's block writes nothing either
    expect(readFileSync(empMirror, 'utf8')).toBe(foreign('the second employee copy'));
    const after = await empApi('PUT', '/api/state', { entries: [entry('after admin adopt')] });
    expect(after.json.mirrorError).toBe(null);
    expect(readFileSync(empMirror, 'utf8')).toContain('after admin adopt');
  }, 120000);

  it('the admin’s OWN block renders once, in the new row — not twice', async () => {
    writeFileSync(adminMirror, foreign('the admin copy'), 'utf8');
    expect(
      (await adminApi('PUT', '/api/state', { entries: [entry('admin blocked')] })).json.mirrorBlocked,
    ).toBeTruthy();
    expect((await empApi('GET', '/api/state')).json.mirrorBlocked).toBe(null); // nobody else's on screen

    await app.page.reload();
    await openSettings(app.page);
    await until(async () => (await noticeTitles(app.page)).length > 0);

    // Exactly one. The old placement drew it under the Mirror folder input; the new section
    // draws it too, and rendering both is the mistake this asserts against.
    const titles = await noticeTitles(app.page);
    expect(titles, `admin Settings read:\n${await settingsText(app.page)}`).toEqual(['Mirror paused']);
    // and the admin-only folder editor is still there, in its own section, with no notice in it
    const text = await settingsText(app.page);
    expect(text).toMatch(/Mirror folder/i);
    expect(text).toMatch(/Markdown mirror/i);
    // …and the new row sits ABOVE the admin-only one, as the ruling's sketch has it
    expect(text.indexOf('Mirror paused')).toBeLessThan(text.search(/Mirror folder/i));
  }, 120000);

  // A silent `pageerror` would let every assertion above pass while the section threw on the
  // way in — both sessions are checked, because only one of them is the admin.
  it('neither session threw', async () => {
    expect(app.pageErrors).toEqual([]);
    expect(emp.pageErrors).toEqual([]);
  }, 30000);
});
