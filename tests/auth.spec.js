const { test, expect } = require('@playwright/test');
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
});
