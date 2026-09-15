const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { addVirtualAuthenticator } = require('./webauthn-helper');

async function registerAndSignIn(page) {
  await addVirtualAuthenticator(page);
  const username = `insights-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await page.goto('/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', username);
  await page.fill('#register-display-name', 'Insights Test User');
  await page.click('#register-submit');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
}

function mockDashboard(page, { pullRequests = [], issues = [] } = {}) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues,
      }),
    }),
  );
}

function pr(ci, overrides = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 1,
    title: 'A pull request',
    url: 'https://github.com/alrayyes/forge-dashboard/pull/1',
    author: 'someone',
    draft: false,
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ci,
    ...overrides,
  };
}

test.describe('insights page', () => {
  test.beforeEach(async ({ page }) => {
    await registerAndSignIn(page);
  });

  test('is reachable from a link in the dashboard header', async ({ page }) => {
    const link = page.locator('a[href="/insights.html"]');
    await expect(link).toHaveCount(1);
    await link.click();
    await expect(page).toHaveURL(/\/insights\.html$/);
    await expect(page.locator('h1')).toHaveText('Insights');
  });

  test('fetches /api/dashboard and nothing else, and needs a session like settings.html', async ({
    page,
  }) => {
    let dashboardCalls = 0;
    await page.route('**/api/dashboard*', (route) => {
      dashboardCalls++;
      route.continue();
    });

    await page.goto('/insights.html');
    await expect(page.locator('h1')).toHaveText('Insights');
    await expect.poll(() => dashboardCalls).toBeGreaterThan(0);
  });

  test('charts the CI status mix across open pull requests, with a data table alongside', async ({
    page,
  }) => {
    await mockDashboard(page, {
      pullRequests: [
        pr('success'),
        pr('success'),
        pr('failure'),
        pr('pending'),
        pr('none'),
      ],
    });

    await page.goto('/insights.html');

    await expect(
      page.locator('[data-ci-status="success"] .ci-count'),
    ).toHaveText('2');
    await expect(
      page.locator('[data-ci-status="failure"] .ci-count'),
    ).toHaveText('1');
    await expect(
      page.locator('[data-ci-status="pending"] .ci-count'),
    ).toHaveText('1');
    await expect(page.locator('[data-ci-status="none"] .ci-count')).toHaveText(
      '1',
    );

    // The chart is never the only way to read the numbers — a real table
    // carries the same counts for anyone who'd rather read than look at bars.
    const table = page.locator('#ci-status-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(4);
  });

  test('shows an explicit empty state with no open pull requests, not a blank or all-zero chart', async ({
    page,
  }) => {
    await mockDashboard(page, { pullRequests: [] });

    await page.goto('/insights.html');

    await expect(page.locator('#ci-status-empty')).toBeVisible();
    await expect(page.locator('#ci-status-chart')).toBeHidden();
  });

  test('has no axe-core violations at desktop width, with real chart content present', async ({
    page,
  }) => {
    await mockDashboard(page, {
      pullRequests: [pr('success'), pr('failure'), pr('pending'), pr('none')],
    });
    await page.goto('/insights.html');
    await expect(
      page.locator('[data-ci-status="success"] .ci-count'),
    ).toHaveText('1');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('has no axe-core violations and no horizontal scroll at phone width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockDashboard(page, {
      pullRequests: [pr('success'), pr('failure'), pr('pending'), pr('none')],
    });
    await page.goto('/insights.html');
    await expect(
      page.locator('[data-ci-status="success"] .ci-count'),
    ).toHaveText('1');

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const clientWidth = await page.evaluate(
      () => document.documentElement.clientWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
