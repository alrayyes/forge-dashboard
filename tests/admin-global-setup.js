// Registers the very first user against the shared e2e server, before
// any test file runs — the server itself has no admin-designating env
// var anymore; whoever completes registration first becomes admin. Not
// a per-file beforeAll, which is worker-scoped and reruns whenever
// Playwright starts a fresh worker (after a crash, or after a prior
// test's failure leaves a worker in a state Playwright decides to
// replace) — a rerun of this same registration would fail outright
// (the username's already taken) and confirmed live, twice, as a
// confusing failure in an unrelated later test. globalSetup has no
// such per-worker lifecycle: it runs once for the whole test run, full
// stop, which is exactly what "the first real registration" needs.
const { chromium } = require('@playwright/test');
const path = require('path');
const { addVirtualAuthenticator } = require('./webauthn-helper');

const ADMIN_TEST_USERNAME = 'admin';
const STORAGE_STATE_PATH = path.join(__dirname, '.auth', 'admin.json');

module.exports = async function globalSetup(config) {
  const baseURL = config.projects[0].use.baseURL;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await addVirtualAuthenticator(page);
  await page.goto(baseURL + '/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', ADMIN_TEST_USERNAME);
  await page.fill('#register-display-name', 'Admin');
  await page.click('#register-submit');
  await page.waitForURL(baseURL + '/', { timeout: 10000 });

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
};

module.exports.ADMIN_TEST_USERNAME = ADMIN_TEST_USERNAME;
module.exports.STORAGE_STATE_PATH = STORAGE_STATE_PATH;
