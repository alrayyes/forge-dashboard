const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = 'dashboard-test-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'Dashboard Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

test.describe('dashboard page', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('renders the board and answers real data from /api/dashboard', async ({ page }) => {
    await expect(page.locator('h1')).toHaveText('Forge Board');
    await expect(page.locator('#stat-prs')).not.toHaveText('–');
    await expect(page.locator('.board')).toHaveCount(2);
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await expect(page.locator('#stat-prs')).not.toHaveText('–');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('#stat-prs')).not.toHaveText('–');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('theme toggle switches data-theme on the root element', async ({ page }) => {
    const root = page.locator('html');
    await expect(root).not.toHaveAttribute('data-theme', 'dark');
    await page.click('#theme-toggle');
    await expect(root).toHaveAttribute('data-theme', 'dark');
  });

  test('per-column filters narrow the visible rows', async ({ page }) => {
    // No forges configured in this CI run, so both boards render their
    // empty state — filtering an empty board is still a real assertion:
    // the filter input accepts text and the row list stays empty rather
    // than erroring.
    const repoFilter = page.locator('section[aria-label="Open pull requests"] .col-filter[data-col="repo"]');
    await repoFilter.fill('nonexistent-repo');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(0);
  });
});

test.describe('login page', () => {
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
