// The browser rung's plumbing (DD-013).
//
// Deliberately NOT under `tests/` — `npm test` is `vitest run --dir tests` and must stay the
// fast, always-green gate. A flaky browser suite erodes trust in the whole ladder faster than
// no browser suite does, so this lives one directory over and runs only from `test:browser`.
//
// The app under test is the REAL built client (`client/dist`) served by the API server itself,
// so there is one origin and one process: no vite, no proxy, no fixture framework. Every run
// gets a throwaway TT_DATA_DIR and TT_MD_DIR, and the server is killed by its OWN pid — never
// by pattern, because `pkill -f` has previously taken out the user's editor.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { freePort } from '../tests/util.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server', 'src', 'index.js');
const CLIENT_DIST = join(ROOT, 'client', 'dist', 'index.html');

export const ADMIN_EMAIL = 'admin@timeturtle.local';
export const ADMIN_PASSWORD = 'browserpw';

/**
 * Spawn a server with its own data + mirror directories on a free port, wait until it answers,
 * and open a headless chromium page already logged in and sitting on Settings.
 */
export async function startApp(opts = {}) {
  if (!existsSync(CLIENT_DIST)) {
    throw new Error(`no built client at ${CLIENT_DIST} — run \`npm run build\` (test:browser does this for you)`);
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'tt-browser-data-'));
  const mdDir = mkdtempSync(join(tmpdir(), 'tt-browser-md-'));
  // SB-057: a throwaway VAULT too, for the `personal` cases. Always created, never pointed at by
  // default — the shape decides whether anything looks at it, and no test may ever point this at
  // a real vault.
  const vaultDir = mkdtempSync(join(tmpdir(), 'tt-browser-vault-'));
  const port = await freePort();
  const child = spawn('node', [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      TT_DATA_DIR: dataDir,
      TT_MD_DIR: mdDir,
      TT_SEED_DEMO: opts.shape === 'personal' ? '0' : '1',
      TT_ADMIN_PASSWORD: ADMIN_PASSWORD,
      ...(opts.shape ? { TT_SHAPE: opts.shape } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });
  for (let i = 0; ; i++) {
    if (exited !== null) throw new Error(`server on ${port} exited with code ${exited} before becoming ready`);
    if (i > 150) throw new Error(`server on ${port} did not become ready`);
    try {
      const res = await fetch(`http://localhost:${port}/api/me`);
      if (res.status) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // SB-133: the `personal` cases run on TT_SHAPE ALONE, with nothing stored — and that used to be
  // impossible here.
  //
  // SB-057 had to pre-store `{ shape: 'personal' }` over HTTP at this exact point, because
  // `TT_SHAPE=personal` with nothing stored left `settings.shape` reading its `team` default, the
  // client PUT the WHOLE settings object on every save, and so the first path typed into
  // Settings → Vault stored `shape: 'team'` and flipped the install out of the very shape it was
  // started in. That workaround is GONE rather than merely unnecessary, deliberately: with it in
  // place these cases could never have caught the defect, and vault-quarantine.test.js types its
  // vault root into the real Vault folder field — the exact gesture that used to do the flipping.
  // It is now the browser-rung witness that the flip is over, and it goes red again if the wire
  // ever starts handing the client a shape nobody chose (see `wireSettings` in server/src/index.js).
  //
  // ## Verified red-green: 2026-07-26 (TRANSCRIBED). With this block removed AND `wireSettings`
  //    put back to `return settings` for an unstored shape — i.e. the defect — 1 of 7 fails, and
  //    it fails as the SYMPTOM rather than as a flag: typing the vault root flips the install to
  //    `team`, the sync engine stops, and no quarantine is ever recorded for the note.
  //      FAIL  is a row in Settings → Vault, naming the note and why it is paused
  //            AssertionError: the server never recorded a quarantine for the note:
  //            expected false to be true

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`http://localhost:${port}`);

  // SB-098 item 1: under `personal` there IS no sign-in — `requireUser` resolves the single
  // local user with no cookie, so `/api/state` answers 200 on the first load and the client
  // never renders the Login screen. Signing in here would hang on a form that does not exist,
  // which is the harness feeling the feature rather than working around it.
  if (opts.shape !== 'personal') {
    await page.locator('input[type=text]').fill(ADMIN_EMAIL);
    await page.locator('input[type=password]').fill(ADMIN_PASSWORD);
    await page.locator('button:has-text("Sign in")').click();
  }

  // SB-098 item 4: a data dir with nothing stored, no TT_SHAPE and one user IS DD-015's open
  // state, so the first-run question renders and it is NOT skippable. Every default-harness
  // case therefore meets it, and answering it here is deliberate rather than a workaround:
  //
  //   • it is DETERMINISTIC, not a "dismiss the modal if it happens to be there" branch. The
  //     server decides (`AppState.shapeOpen`) on exactly the conditions reproduced above, so
  //     the modal is present precisely when `opts.shape` is unset and absent otherwise. A
  //     timing-dependent probe here would be a flake source in every browser test at once.
  //   • it answers "my company's", which is the TRAP HALF. The open state resolves to an
  //     effective `team`, so this is the answer that a compare-first gesture would silently
  //     swallow (SB-133's early return) — leaving the question open and this click useless. If
  //     that regression ever lands, `+ client` below is never reachable and EVERY browser test
  //     goes red on the same line, which is a louder alarm than one dedicated test.
  // `onboarding: true` stops HERE, with the question still on screen and unanswered, for the one
  // test whose subject is the question itself. It cannot go on to Settings: the modal is not
  // skippable, so the nav behind it is genuinely unreachable — which is the property under test.
  if (opts.onboarding) return { port, child, dataDir, mdDir, vaultDir, browser, page, pageErrors };
  if (!opts.shape) {
    await page.locator('[data-tt="shape-choice-team"]').waitFor({ timeout: 15000 });
    await page.locator('[data-tt="shape-choice-team"]').click();
    await page.locator('[data-tt="shape-choice"]').waitFor({ state: 'detached', timeout: 15000 });
  }

  await page.locator('text=Settings').first().waitFor({ timeout: 15000 });
  await page.locator('text=Settings').first().click();
  await page.locator('button:has-text("+ client")').first().waitFor({ timeout: 15000 });

  return { port, child, dataDir, mdDir, vaultDir, browser, page, pageErrors };
}

/**
 * SB-095: a SECOND logged-in browser session against the same server, in its own context so
 * it gets its own cookie jar — the admin page stays logged in as the admin.
 *
 * This exists because "an employee cannot reach X" is a role claim, and a role claim is only
 * proven from a real session in that role. Reading the permission check proves nothing, and
 * neither does the admin's own page.
 *
 * @returns {Promise<{ context: any, page: import('playwright').Page, pageErrors: string[] }>}
 */
export async function loginAs(app, email, password) {
  const context = await app.browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://localhost:${app.port}`);
  await page.locator('input[type=text]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.locator('button:has-text("Sign in")').click();
  await page.locator('text=Settings').first().waitFor({ timeout: 15000 });
  return { context, page, pageErrors };
}

/** Tear down page, browser and server. The server dies by explicit pid, never by pattern. */
export async function stopApp(app) {
  if (!app) return;
  await app.browser?.close().catch(() => {});
  if (app.child && app.child.exitCode === null) {
    await new Promise((ok) => {
      app.child.on('exit', ok);
      process.kill(app.child.pid, 'SIGKILL');
    });
  }
}

/**
 * Tag the settings inputs we drive and read back what they currently DISPLAY.
 *
 * CSS-module class names are hashed, so the only stable anchors in the built bundle are the
 * button labels — walk up from `+ client` to the nearest ancestor that owns inputs. The values
 * returned are read straight off the DOM nodes, which is the whole point at this rung: what the
 * control shows, not what the store holds.
 *
 * @param {import('playwright').Page} page
 */
export function readClientRows(page) {
  return page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ client');
    if (!button) throw new Error('no "+ client" button on the page — is this the Settings view?');
    let section = button;
    while (section && section.querySelectorAll('input').length === 0) section = section.parentElement;
    if (!section) throw new Error('found "+ client" but no inputs under any ancestor');
    document.querySelectorAll('[data-tt]').forEach((e) => e.removeAttribute('data-tt'));
    return [...section.children]
      .filter((row) => row.querySelector('input'))
      .map((row, i) => {
        const inputs = row.querySelectorAll('input');
        inputs[0].setAttribute('data-tt', `c${i}-id`);
        inputs[1].setAttribute('data-tt', `c${i}-name`);
        return { i, id: inputs[0].value, name: inputs[1].value };
      });
  });
}

/** The markdown mirror the server writes for the admin user. */
export function mirrorText(mdDir) {
  const file = readdirSync(mdDir).find((f) => f.startsWith('timesheet-') && f.endsWith('.md'));
  return file ? readFileSync(join(mdDir, file), 'utf8') : '';
}

/** Just the `## clients` table, so an assertion failure prints the block and not the whole file. */
export function clientsBlock(mdDir) {
  const text = mirrorText(mdDir);
  return text.includes('## clients') ? text.split('## clients')[1].split('\n##')[0] : text;
}

/**
 * Poll until `predicate` holds or the budget runs out. The mirror is written after a debounced
 * sync, so the alternative is a fixed sleep — which is either flaky or slow, and usually both.
 */
export async function until(predicate, { timeout = 15000, step = 150 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}
