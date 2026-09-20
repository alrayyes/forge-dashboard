// The bare `request` import here is Playwright's own top-level
// `APIRequest` factory (its `.newContext()` is what builds an isolated
// context carrying a chosen storageState) — a different thing from the
// per-test `request` *fixture* (an already-built `APIRequestContext`,
// no `.newContext()` of its own) that every call site below still
// receives and passes through as its own `request` parameter. Real bug,
// hit live: passing the fixture straight to `.newContext()` fails with
// "request.newContext is not a function" the first time any test
// actually calls this. The parameter is kept (rather than dropped) so
// every spec file's own registerAndSignIn/registerUser wrapper — most of
// which also use their own `request` fixture for other things — doesn't
// need a second, differently-shaped helper just for this.
const { expect, request } = require('@playwright/test');
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
// baseURL is Playwright's own fixture — pass it straight through from a
// test's (or beforeEach's) own destructured arguments, the same way
// `page` already gets passed to this and every spec file's own
// `registerAndSignIn`/`registerUser` wrapper. The `request` parameter
// (named `_request`, unused) is accepted only for call-site consistency
// — see the top-of-file comment.
async function registerViaInvite(
  page,
  _request,
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
