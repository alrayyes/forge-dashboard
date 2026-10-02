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
import { expect, type Page, request } from '@playwright/test';
import { STORAGE_STATE_PATH as ADMIN_STORAGE_STATE } from './admin-global-setup';
import { addVirtualAuthenticator } from './webauthn-helper';

// admin-global-setup.ts bootstraps the very first user ("admin") once,
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
  page: Page,
  _request: unknown,
  baseURL: string | undefined,
  username: string,
  displayName: string,
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
  // Under heavy host load (many workers plus other processes) the invite
  // page has been seen not showing its form for the whole 30s test budget
  // (#736). A wedged page load gets one fresh attempt after 10s instead of
  // eating the budget; a second miss fails with its own message.
  const submit = page.locator('#register-submit');
  try {
    await submit.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    await page.reload();
    await submit.waitFor({ state: 'visible', timeout: 10000 });
  }
  await submit.click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

export { registerViaInvite };
