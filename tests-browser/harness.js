// The browser rung's plumbing (DD-013).
//
// Deliberately NOT under `tests/` — `npm test` is `vitest run --dir tests` and must stay the
// fast, always-green gate. A flaky browser suite erodes trust in the whole ladder faster than
// no browser suite does, so this lives one directory over and runs only from `test:browser`.
//
// The app under test is the REAL built client (`client/dist`) served by the API server itself,
// so there is one origin and one process: no vite, no proxy, no fixture framework. Every run
// gets a throwaway TT_DATA_DIR, and the server is killed by its OWN pid — never by pattern,
// because `pkill -f` has previously taken out the user's editor.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
 * DD-024 clause 2: the password `server/src/config.js` publishes, and the only one `<Login>` is
 * ever allowed to state back. Written here as a literal rather than imported, deliberately — a
 * test that imports the constant it is checking asserts nothing about the value.
 */
export const PUBLISHED_PASSWORD = 'turtle';

/**
 * Spawn a server with its own data directory on a free port, wait until it answers, and open a
 * headless chromium page already logged in and sitting on Settings.
 */
export async function startApp(opts = {}) {
  if (!existsSync(CLIENT_DIST)) {
    throw new Error(`no built client at ${CLIENT_DIST} — run \`npm run build\` (test:browser does this for you)`);
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'tt-browser-data-'));
  const port = await freePort();
  const child = spawn('node', [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      TT_DATA_DIR: dataDir,
      // `onboarding` cases get NOTHING seeded, and that is not tidiness: DD-024 clause 3 makes the
      // demo content a step the first run ASKS for, so an onboarding case that boots with demo
      // hours already in it is not the fresh install it claims to be. Every other case keeps the
      // boot seed it has always had.
      TT_SEED_DEMO: opts.onboarding ? '0' : '1',
      // DD-024 clause 2: `defaultPassword: true` leaves TT_ADMIN_PASSWORD UNSET, so the seeded
      // admin carries the password this repo publishes and the login hint is in force. Every other
      // case sets its own password, which is also what keeps the hint out of their way.
      ...(opts.defaultPassword ? {} : { TT_ADMIN_PASSWORD: ADMIN_PASSWORD }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drained, not read — nothing here pretends to assert on the boot banner.
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

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`http://localhost:${port}`);

  // THE FIRST RUN COMES FIRST (DD-024 / SB-158). On a fresh install there is no login form to
  // sign into until the question is answered, so this answers it and then signs in.
  //
  // Nothing here is a "dismiss it if it happens to be there" branch: the server decides on
  // conditions this function controls exactly — one user, nothing answered — so the first run is
  // always present here. A timing-dependent probe would be a flake source in every browser test.
  //
  // `onboarding: true` stops HERE, with the question on screen and unanswered, for the tests whose
  // subject is the first run itself.
  if (opts.onboarding) return { port, child, dataDir, browser, page, pageErrors };
  // The demo box is left unchecked: these cases build their own data and `TT_SEED_DEMO=1` has
  // already seeded at boot.
  await page.locator('[data-tt="first-run-demo-submit"]').waitFor({ timeout: 15000 });
  await page.locator('[data-tt="first-run-demo-submit"]').click();

  await page.locator('input[type=text]').waitFor({ timeout: 15000 });
  await page.locator('input[type=text]').fill(ADMIN_EMAIL);
  await page.locator('input[type=password]').fill(opts.defaultPassword ? PUBLISHED_PASSWORD : ADMIN_PASSWORD);
  await page.locator('button:has-text("Sign in")').click();

  await page.locator('text=Settings').first().waitFor({ timeout: 15000 });
  await page.locator('text=Settings').first().click();
  await page.locator('button:has-text("+ client")').first().waitFor({ timeout: 15000 });

  return { port, child, dataDir, browser, page, pageErrors };
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

/**
 * Poll until `predicate` holds or the budget runs out. A save is debounced, so the alternative is
 * a fixed sleep — which is either flaky or slow, and usually both.
 */
export async function until(predicate, { timeout = 15000, step = 150 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}
