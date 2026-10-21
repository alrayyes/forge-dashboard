import { expect } from '@playwright/test';
import { addOwnerPasskey, OWNER_USERNAME, test } from './server-fixture';
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

    await page.fill('#login-username', OWNER_USERNAME);
    await page.click('#login-submit');

    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
    await expect(page.locator('#whoami')).toHaveText('Owner');
  });

  test('a wrong username at login fails without a session being issued', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await addVirtualAuthenticator(page);

    await page.goto('/login.html');
    await page.fill('#login-username', 'this-username-was-never-registered');
    await page.click('#login-submit');

    await expect(page.locator('#status')).toContainText(/no account/i, {
      timeout: 5000,
    });
    await expect(page).toHaveURL(/\/login\.html$/);
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
    await page.fill('#register-username', 'first-owner');
    await page.fill('#register-display-name', 'First Owner');
    await page.click('#register-submit');

    await expect(page).toHaveURL(`${freshServer.baseURL}/`, {
      timeout: 10000,
    });
    await expect(page.locator('#whoami')).toHaveText('First Owner');

    await page.click('#logout-button');
    await expect(page).toHaveURL(/\/login\.html$/);
    await page.goto(`${freshServer.baseURL}/login.html`);
    await expect(page.locator('#show-register')).toHaveCount(0);
  });
});
