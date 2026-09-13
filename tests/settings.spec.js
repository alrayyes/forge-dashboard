const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = 'settings-test-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'Settings Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

test.describe('settings page', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('the header settings link reaches the settings page', async ({ page }) => {
    await page.click('a[href="/settings.html"]');
    await expect(page).toHaveURL(/\/settings\.html$/);
    await expect(page.locator('h1')).toHaveText('Settings');
  });

  test('saved settings persist across a reload, and the token never comes back', async ({ page }) => {
    await page.goto('/settings.html');

    await page.fill('#github-token', 'ghp_e2e-test-token-should-not-round-trip');
    await page.fill('#github-username', 'octocat');
    await page.fill('#forgejo-url', 'https://git.example.com');
    await page.fill('#forgejo-username', 'octocat-forgejo');
    await page.click('#save-button');

    await expect(page.locator('#status')).toHaveText('Saved.');
    await expect(page.locator('#github-token-badge')).toBeVisible();
    // Cleared after a successful save — the "Configured" badge is what
    // confirms it took, not the input showing the secret back.
    await expect(page.locator('#github-token')).toHaveValue('');

    await page.reload();

    await expect(page.locator('#github-username')).toHaveValue('octocat');
    await expect(page.locator('#forgejo-url')).toHaveValue('https://git.example.com');
    await expect(page.locator('#forgejo-username')).toHaveValue('octocat-forgejo');
    await expect(page.locator('#github-token-badge')).toBeVisible();
    await expect(page.locator('#github-token')).toHaveValue('');
  });

  test('a Forgejo username with no instance URL is refused before it ever reaches the server', async ({ page }) => {
    await page.goto('/settings.html');

    await page.fill('#forgejo-username', 'octocat-forgejo');
    await page.click('#save-button');

    await expect(page.locator('#status')).toContainText(/instance url/i);

    await page.reload();
    await expect(page.locator('#forgejo-username')).toHaveValue('', { timeout: 5000 });
  });

  test('the Forgejo token-settings link tracks the instance URL field and is inert when it is empty', async ({ page }) => {
    await page.goto('/settings.html');

    await expect(page.locator('#forgejo-token-link')).not.toHaveAttribute('href', /.+/);

    await page.fill('#forgejo-url', 'git.example.com');
    await expect(page.locator('#forgejo-token-link')).toHaveAttribute('href', 'https://git.example.com/user/settings/applications');
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await page.goto('/settings.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings.html');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
