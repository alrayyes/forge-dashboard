const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

// One username per test run so parallel/repeated runs never collide on
// "already registered" — the server has no reset endpoint and shouldn't.
function uniqueUsername(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

test.describe('passkey login', () => {
  test('an unauthenticated visitor is redirected to the login page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\.html$/);
  });

  test('dark mode chosen while signed in still applies on the login page after logging out', async ({ page }) => {
    await addVirtualAuthenticator(page);
    const username = uniqueUsername('e2e-theme');

    await page.goto('/login.html');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-display-name', 'Theme Test User');
    await page.click('#register-submit');
    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });

    await page.click('#theme-toggle');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.click('#logout-button');
    await expect(page).toHaveURL(/\/login\.html$/);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the login page shows the running version with no session at all', async ({ page }) => {
    // /api/version needs no session, so this works on the one page a
    // visitor can reach before ever authenticating.
    await page.goto('/login.html');
    // Also carries a "Release history" link now (see releases.spec.js) —
    // this test's own concern is just that the version itself shows up
    // with no session at all.
    await expect(page.locator('#footer-version')).toContainText('· dev build');
  });

  test('register a passkey with a real WebAuthn ceremony, then reach the dashboard', async ({ page }) => {
    await addVirtualAuthenticator(page);
    const username = uniqueUsername('e2e');

    await page.goto('/login.html');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-display-name', 'E2E Test User');
    await page.click('#register-submit');

    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
    await expect(page.locator('h1')).toHaveText('Forge Board');
    await expect(page.locator('#whoami')).toHaveText('E2E Test User');
  });

  test('log out, then log back in with the same passkey', async ({ page }) => {
    await addVirtualAuthenticator(page);
    const username = uniqueUsername('e2e');

    await page.goto('/login.html');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-display-name', 'Login Roundtrip');
    await page.click('#register-submit');
    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });

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

  test('a wrong username at login fails without a session being issued', async ({ page }) => {
    await addVirtualAuthenticator(page);

    await page.goto('/login.html');
    await page.fill('#login-username', 'this-username-was-never-registered');
    await page.click('#login-submit');

    await expect(page.locator('#status')).toContainText(/no account/i, { timeout: 5000 });
    await expect(page).toHaveURL(/\/login\.html$/);
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await page.goto('/login.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
