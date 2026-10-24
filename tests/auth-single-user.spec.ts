import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { addOwnerPasskey, test } from './server-fixture';
import { addVirtualAuthenticator } from './webauthn-helper';

// The sign-in tests on a server with one owner. The page starts signed in as
// that owner; a test about a visitor with no session clears its cookies first.

test.describe('passkey login, one owner', () => {
  test('an unauthenticated visitor is redirected to the login page', async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    await page.goto('/');

    await expect(page).toHaveURL(/\/login\.html$/);
  });

  test('dark mode chosen in Settings while signed in still applies on the login page after logging out', async ({
    page,
  }) => {
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
    context,
  }) => {
    await context.clearCookies();

    // /api/version needs no session, so this works on the one page a
    // visitor can reach before ever authenticating.
    await page.goto('/login.html');

    // This test's own concern is just that the version itself shows up
    // with no session at all.
    await expect(page.locator('#footer-version')).toContainText('· dev build');
  });

  test('log out, then log back in with the same passkey', async ({
    page,
    server,
  }) => {
    await addOwnerPasskey(page, server);
    await page.goto('/');
    await expect(page.locator('#whoami')).toHaveText('Owner');

    await page.click('#logout-button');
    await expect(page).toHaveURL(/\/login\.html$/);

    // A fresh page load after logout should redirect straight back to
    // login, proving the session was actually cleared server-side and
    // this isn't just the button changing what the page shows.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\.html$/);

    await page.click('#login-submit');

    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
    await expect(page.locator('#whoami')).toHaveText('Owner');
  });

  test('the login page asks for no username, only a sign-in action', async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    await page.goto('/login.html');

    await expect(page.locator('#login-submit')).toBeVisible();
    await expect(page.locator('#login-form input')).toHaveCount(0);
  });

  test('an authenticator without the owner passkey signs nobody in', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await addVirtualAuthenticator(page);

    await page.goto('/login.html');
    await page.click('#login-submit');

    await expect(page.locator('#status')).toHaveClass(/error/, {
      timeout: 10000,
    });
    await expect(page).toHaveURL(/\/login\.html$/);
  });

  test('a second failed prompt in a row names the reset command', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await addVirtualAuthenticator(page);

    await page.goto('/login.html');
    await page.click('#login-submit');
    await expect(page.locator('#status')).toHaveText(
      'Sign-in was cancelled or timed out. Try again.',
      { timeout: 10000 },
    );

    await page.click('#login-submit');
    await expect(page.locator('#status')).toContainText(
      'forge-dashboard reset-passkeys',
      { timeout: 10000 },
    );
  });

  test('after reset-passkeys, signing in switches to creating the first passkey', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    // The state reset-passkeys leaves: registration open, no passkey to sign in
    // with. The server's answers are stood in for so the real owner stays put;
    // which status each case gets is proved in the API tests.
    await page.route('**/api/auth/registration-status', (route) =>
      route.fulfill({ json: { open: true } }),
    );
    await page.route('**/api/auth/login/begin', (route) =>
      route.fulfill({
        status: 404,
        json: { error: 'no passkey is registered yet' },
      }),
    );

    await page.goto('/login.html');
    await page.click('#login-submit');

    await expect(page.locator('#register-submit')).toBeVisible();
    await expect(page.locator('#status')).toHaveText(
      'No passkey is registered yet. Create the first one.',
    );
  });

  test('a failed first registration check does not strand the visitor after a 404', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    // The check made when the page loads fails; the one made when sign-in
    // answers 404 gets through.
    let asked = 0;
    await page.route('**/api/auth/registration-status', (route) =>
      asked++ === 0 ? route.abort() : route.fulfill({ json: { open: true } }),
    );
    await page.route('**/api/auth/login/begin', (route) =>
      route.fulfill({
        status: 404,
        json: { error: 'no passkey is registered yet' },
      }),
    );

    await page.goto('/login.html');
    await page.click('#login-submit');

    await expect(page.locator('#register-submit')).toBeVisible();
  });

  test('a limited address is told to wait, not that sign-in failed', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    // The limit itself is proved in the API tests; the e2e server runs
    // without it, so its answer is stood in for.
    await page.route('**/api/auth/login/begin', (route) =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '6' },
        json: { error: 'too many sign-in attempts, try again in 6 seconds' },
      }),
    );

    await page.goto('/login.html');
    await page.click('#login-submit');

    await expect(page.locator('#status')).toHaveText(
      'Too many sign-in attempts. Try again in 6 seconds.',
    );
    await expect(page.locator('#status')).toHaveClass(/error/);
  });

  test('the register button is absent once an owner exists', async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    // The server already has its owner, so registration-status answers closed:
    // the page has to ask the server rather than default to showing the button.
    await page.goto('/login.html');
    await expect(page.locator('#show-register')).toHaveCount(0);
  });
});

test.describe('the first visit', () => {
  test('registers the owner, who reaches the dashboard, and registration is closed afterwards', async ({
    page,
    freshServer,
  }) => {
    await addVirtualAuthenticator(page);
    await page.goto(`${freshServer.baseURL}/login.html`);
    await page.click('#show-register');
    await expect(page.locator('#register-form input')).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
    await page.click('#register-submit');

    await expect(page).toHaveURL(`${freshServer.baseURL}/`, {
      timeout: 10000,
    });
    await expect(page.locator('#whoami')).toHaveText('Owner');

    await page.click('#logout-button');
    await expect(page).toHaveURL(/\/login\.html$/);
    await page.goto(`${freshServer.baseURL}/login.html`);
    await expect(page.locator('#show-register')).toHaveCount(0);
  });
});
