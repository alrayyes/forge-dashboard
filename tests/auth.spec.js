// `request` here is Playwright's top-level APIRequest factory (its own
// `.newContext()` builds an isolated context carrying a chosen
// storageState) — not the per-test `request` fixture a test callback
// destructures, which has no `.newContext()` of its own. See
// register-helper.js's own top-of-file comment for the real bug this
// distinction caused live.
const { test, expect, request: apiRequest } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');
const { registerViaInvite } = require('./register-helper');
const {
  STORAGE_STATE_PATH: ADMIN_STORAGE_STATE,
} = require('./admin-global-setup');

// One username per test run so parallel/repeated runs never collide on
// "already registered" — the server has no reset endpoint and shouldn't.
function uniqueUsername(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test.describe('passkey login', () => {
  test('an unauthenticated visitor is redirected to the login page', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\.html$/);
  });

  test('dark mode chosen in Settings while signed in still applies on the login page after logging out', async ({
    page,
    request,
    baseURL,
  }) => {
    const username = uniqueUsername('e2e-theme');
    await registerViaInvite(
      page,
      request,
      baseURL,
      username,
      'Theme Test User',
    );

    // #352: theme is a Settings-only control now, not a header toggle —
    // login.html has no session at all, so it can only ever read the
    // cookie fast-cache, never the server; this proves that cache
    // actually gets written by Settings' own control, not just applied.
    await page.goto('/settings.html');
    await page.click('.theme-segmented label:has-text("Dark")');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.click('#logout-button');
    await expect(page).toHaveURL(/\/login\.html$/);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the login page shows the running version with no session at all', async ({
    page,
  }) => {
    // /api/version needs no session, so this works on the one page a
    // visitor can reach before ever authenticating.
    await page.goto('/login.html');
    // Also carries a "Release history" link now (see releases.spec.js) —
    // this test's own concern is just that the version itself shows up
    // with no session at all.
    await expect(page.locator('#footer-version')).toContainText('· dev build');
  });

  // admin-global-setup.js already registered "admin" before any test
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

  test('log out, then log back in with the same passkey', async ({
    page,
    request,
    baseURL,
  }) => {
    const username = uniqueUsername('e2e');
    await registerViaInvite(
      page,
      request,
      baseURL,
      username,
      'Login Roundtrip',
    );

    await page.click('#logout-button');
    await expect(page).toHaveURL(/\/login\.html$/);

    // A fresh page load after logout should redirect straight back to
    // login, proving the session was actually cleared server-side and
    // this isn't just the button changing what the page shows.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\.html$/);

    await page.fill('#login-username', username);
    await page.click('#login-submit');

    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
    await expect(page.locator('#whoami')).toHaveText('Login Roundtrip');
  });

  test('a wrong username at login fails without a session being issued', async ({
    page,
  }) => {
    await addVirtualAuthenticator(page);

    await page.goto('/login.html');
    await page.fill('#login-username', 'this-username-was-never-registered');
    await page.click('#login-submit');

    await expect(page.locator('#status')).toContainText(/no account/i, {
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/login\.html$/);
  });

  test('the register button is absent once a user exists and no invite is present', async ({
    page,
  }) => {
    // admin-global-setup.js's own "admin" account already exists by the
    // time this runs, so registration-status answers closed — no invite
    // query param on this visit, so the page has to ask the server
    // rather than default to showing the button.
    await page.goto('/login.html');
    await expect(page.locator('#show-register')).toHaveCount(0);
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

    await expect(page.locator('#status')).toContainText(/invalid|expired/i, {
      timeout: 5000,
    });
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
