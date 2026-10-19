// `request` here is Playwright's top-level APIRequest factory (its own
// `.newContext()` builds an isolated context carrying a chosen
// storageState) — not the per-test `request` fixture a test callback
// destructures, which has no `.newContext()` of its own. See
// register-helper.ts's own top-of-file comment for the real bug this
// distinction caused live.

import AxeBuilder from '@axe-core/playwright';
import { request as apiRequest, expect } from '@playwright/test';
import { STORAGE_STATE_PATH as ADMIN_STORAGE_STATE } from './admin-global-setup';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { addVirtualAuthenticator } from './webauthn-helper';

// One username per test run so parallel/repeated runs never collide on
// "already registered" — the server has no reset endpoint and shouldn't.
function uniqueUsername(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test.describe('passkey login', () => {
  // admin-global-setup.ts already registered "admin" before any test
  // file runs, so self-registration is closed for this whole suite the
  // same way it is for any real deployment past its first account —
  // #477's own requirement. Register via an admin-issued invite instead.
  test('register a passkey via an admin-issued invite, then reach the dashboard', async ({
    page,
    request,
    baseURL,
  }) => {
    const username = uniqueUsername('e2e');
    await registerViaInvite(page, request, baseURL, username, 'E2E Test User');

    await expect(page.locator('h1')).toHaveText('Forge Board');
    await expect(page.locator('#whoami')).toHaveText('E2E Test User');
  });

  test('visiting /login?invite=<token> from a freshly created invite shows the invite-scoped form and completes registration', async ({
    page,
    baseURL,
  }) => {
    const username = uniqueUsername('e2e-invite');
    const adminRequest = await apiRequest.newContext({
      baseURL,
      storageState: ADMIN_STORAGE_STATE,
    });
    const inviteRes = await adminRequest.post('/api/admin/invites', {
      data: { username, displayName: 'Invited User' },
    });
    expect(inviteRes.ok()).toBeTruthy();
    const invite = await inviteRes.json();
    await adminRequest.dispose();

    await addVirtualAuthenticator(page);
    await page.goto(
      `/login.html?invite=${encodeURIComponent(invite.token)}&username=${encodeURIComponent(username)}`,
    );

    // No username/display-name fields to fill — both are already fixed
    // by the invite (design.md) — just the invite-scoped form's own
    // "Create passkey" action.
    await expect(page.locator('#register-username')).toHaveCount(0);
    await expect(page.locator('.invite-note')).toContainText(username);
    await page.click('#register-submit');

    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
    await expect(page.locator('#whoami')).toHaveText('Invited User');
  });

  test('an expired or already-consumed invite link shows an error and does not register', async ({
    page,
    baseURL,
  }) => {
    const username = uniqueUsername('e2e-consumed');
    const adminRequest = await apiRequest.newContext({
      baseURL,
      storageState: ADMIN_STORAGE_STATE,
    });
    const inviteRes = await adminRequest.post('/api/admin/invites', {
      data: { username, displayName: 'Consumed Invite User' },
    });
    const invite = await inviteRes.json();

    // Spend the invite once for real, then try the exact same link again
    // — same shape as a browser-history revisit or a link reused after
    // it already worked.
    const firstPage = await page.context().newPage();
    await addVirtualAuthenticator(firstPage);
    await firstPage.goto(
      `/login.html?invite=${encodeURIComponent(invite.token)}&username=${encodeURIComponent(username)}`,
    );
    await firstPage.click('#register-submit');
    await expect(firstPage).toHaveURL(/\/$/, { timeout: 10000 });
    await firstPage.close();
    await adminRequest.dispose();

    await addVirtualAuthenticator(page);
    await page.goto(
      `/login.html?invite=${encodeURIComponent(invite.token)}&username=${encodeURIComponent(username)}`,
    );
    await page.click('#register-submit');

    // The account from the first, successful registration still exists,
    // so this second attempt is rejected as "username already
    // registered" rather than "invalid invite" — the same
    // already-registered-check-runs-first order
    // TestRegisterBegin_AfterBootstrap_WithExpiredOrConsumedOrMismatchedInvite_IsRefused
    // exercises directly in internal/api/auth_test.go. Both are a
    // real, correct "error, no second account" outcome for a reused
    // link, which is this test's actual concern.
    await expect(page.locator('#status')).toContainText(
      /invalid|expired|already registered/i,
      { timeout: 5000 },
    );
    await expect(page).toHaveURL(/\/login\.html/);
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await page.goto('/login.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const clientWidth = await page.evaluate(
      () => document.documentElement.clientWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
