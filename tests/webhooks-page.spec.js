const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = `webhooks-page-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'Webhooks Page Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

function mockDashboard(page, repos) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos,
      }),
    }),
  );
}

test.describe('webhooks page', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('shows an empty state with no tracked repos', async ({ page }) => {
    await mockDashboard(page, []);
    await page.goto('/webhooks.html');

    await expect(page.locator('#webhooks-empty')).toBeVisible();
    await expect(page.locator('#webhooks-table')).toBeHidden();
  });

  test('lists every tracked repo with its live status, sorted by full name', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
    ]);
    await page.goto('/webhooks.html');

    const rows = page.locator('#webhooks-rows tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('alrayyes/a');
    await expect(rows.nth(0)).toContainText('Confirmed');
    await expect(rows.nth(1)).toContainText('alrayyes/b');
    await expect(rows.nth(1)).toContainText('Not yet');
    await expect(
      rows.nth(1).getByRole('link', { name: 'Add a webhook' }),
    ).toHaveAttribute('href', '/settings.html#webhooks');
    await expect(
      rows.nth(0).getByRole('link', { name: 'Add a webhook' }),
    ).toHaveCount(0);
  });

  test('paginates at 25 per page, same convention as the pull request/issue boards', async ({
    page,
  }) => {
    const repos = Array.from({ length: 30 }, (_, i) => ({
      forge: 'github',
      fullName: `alrayyes/repo-${String(i).padStart(2, '0')}`,
      hasWebhook: false,
    }));
    await mockDashboard(page, repos);
    await page.goto('/webhooks.html');

    await expect(page.locator('#webhooks-rows tr')).toHaveCount(25);
    await expect(page.locator('#webhooks-pagination')).toBeVisible();

    await page.locator('.pagination-page', { hasText: '2' }).click();
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(5);
  });

  test('a set under one page shows no pagination controls', async ({
    page,
  }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
    ]);
    await page.goto('/webhooks.html');

    await expect(page.locator('#webhooks-pagination')).toBeHidden();
  });

  test('has no axe-core violations at desktop width', async ({ page }) => {
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
    ]);
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-table')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockDashboard(page, [
      { forge: 'github', fullName: 'alrayyes/a', hasWebhook: true },
      { forge: 'github', fullName: 'alrayyes/b', hasWebhook: false },
    ]);
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-table')).toBeVisible();

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

  test('the dashboard header links to the webhooks page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[aria-label="Webhooks"]');
    await expect(page).toHaveURL(/\/webhooks\.html$/);
  });
});
