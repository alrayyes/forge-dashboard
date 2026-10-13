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

import path from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';
import { SHARED_STORAGE_STATE_PATH, SHARED_USERNAME } from './shared-session';
import { addVirtualAuthenticator } from './webauthn-helper';

export const ADMIN_TEST_USERNAME = 'admin';
export const STORAGE_STATE_PATH = path.join(__dirname, '.auth', 'admin.json');

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await addVirtualAuthenticator(page);
  await page.goto(`${baseURL}/login.html`);
  await page.click('#show-register');
  await page.fill('#register-username', ADMIN_TEST_USERNAME);
  await page.fill('#register-display-name', 'Admin');
  await page.click('#register-submit');
  await page.waitForURL(`${baseURL}/`, { timeout: 10000 });

  await context.storageState({ path: STORAGE_STATE_PATH });

  // The shared ordinary user (shared-session.ts): invited by the admin just
  // signed in, registered in a fresh context, its session saved for the specs
  // that use it.
  const inviteRes = await context.request.post(`${baseURL}/api/admin/invites`, {
    data: { username: SHARED_USERNAME, displayName: 'Shared test user' },
  });
  if (!inviteRes.ok())
    throw new Error(
      `could not invite ${SHARED_USERNAME} (${inviteRes.status()}): ${await inviteRes.text()}`,
    );
  const invite = await inviteRes.json();
  const sharedContext = await browser.newContext();
  const sharedPage = await sharedContext.newPage();
  await addVirtualAuthenticator(sharedPage);
  await sharedPage.goto(
    `${baseURL}/login.html?invite=${encodeURIComponent(invite.token)}&username=${encodeURIComponent(SHARED_USERNAME)}`,
  );
  await sharedPage.locator('#register-submit').click();
  await sharedPage.waitForURL(`${baseURL}/`, { timeout: 10000 });
  await sharedContext.storageState({ path: SHARED_STORAGE_STATE_PATH });

  await browser.close();
}
