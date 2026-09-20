const { expect } = require('@playwright/test');
const { addVirtualAuthenticator } = require('./webauthn-helper');
const {
  STORAGE_STATE_PATH: ADMIN_STORAGE_STATE,
} = require('./admin-global-setup');

// admin-global-setup.js bootstraps the very first user ("admin") once,
// before any test file runs — so by the time any spec file's own tests
// run, self-registration is already closed (#477): every other account
// this suite creates has to go through an admin-issued invite instead of
// the open "Register a new passkey instead" flow every spec used before.
//
// request/baseURL are Playwright's own fixtures — pass them straight
// through from a test's (or beforeEach's) own destructured arguments,
// the same way `page` already gets passed to this and every spec file's
// own `registerAndSignIn`/`registerUser` wrapper.
async function registerViaInvite(
  page,
  request,
  baseURL,
  username,
  displayName,
) {
  const adminRequest = await request.newContext({
    baseURL,
    storageState: ADMIN_STORAGE_STATE,
  });
  const inviteRes = await adminRequest.post('/api/admin/invites', {
    data: { username, displayName },
  });
  if (!inviteRes.ok()) {
    const body = await inviteRes.text();
    await adminRequest.dispose();
    throw new Error(
      `could not create invite for ${username} (${inviteRes.status()}): ${body}`,
    );
  }
  const invite = await inviteRes.json();
  await adminRequest.dispose();

  await addVirtualAuthenticator(page);
  await page.goto(
    `/login.html?invite=${encodeURIComponent(invite.token)}&username=${encodeURIComponent(username)}`,
  );
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

module.exports = { registerViaInvite };
