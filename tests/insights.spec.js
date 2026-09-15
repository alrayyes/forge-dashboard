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

function issue(overrides = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 1,
    title: 'An issue',
    url: 'https://github.com/alrayyes/forge-dashboard/issues/1',
    author: 'someone',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function prsForRepo(repo, count) {
  return Array.from({ length: count }, (_, i) =>
    pr('success', { repo, number: i + 1 }),
  );
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
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

  test.describe('busiest repos', () => {
    test('ranks repos by open pull request count, each row labeled with the repo name and count', async ({
      page,
    }) => {
      await mockDashboard(page, {
        pullRequests: [
          ...prsForRepo('alrayyes/one', 3),
          ...prsForRepo('alrayyes/two', 1),
          ...prsForRepo('alrayyes/three', 2),
        ],
      });

      await page.goto('/insights.html');

      const rows = page.locator('#repo-pr-ranking .rank-row');
      await expect(rows).toHaveCount(3);
      // Ranked highest count first.
      await expect(rows.nth(0)).toContainText('alrayyes/one');
      await expect(rows.nth(0).locator('.rank-count')).toHaveText('3');
      await expect(rows.nth(1)).toContainText('alrayyes/three');
      await expect(rows.nth(1).locator('.rank-count')).toHaveText('2');
      await expect(rows.nth(2)).toContainText('alrayyes/two');
      await expect(rows.nth(2).locator('.rank-count')).toHaveText('1');
    });

    test('ranks issues separately from pull requests, not conflated into one number', async ({
      page,
    }) => {
      await mockDashboard(page, {
        pullRequests: prsForRepo('alrayyes/pr-heavy', 5),
        issues: [
          issue({ repo: 'alrayyes/issue-heavy', number: 1 }),
          issue({ repo: 'alrayyes/issue-heavy', number: 2 }),
        ],
      });

      await page.goto('/insights.html');

      const prRows = page.locator('#repo-pr-ranking .rank-row');
      await expect(prRows).toHaveCount(1);
      await expect(prRows.first()).toContainText('alrayyes/pr-heavy');
      await expect(prRows.first().locator('.rank-count')).toHaveText('5');

      const issueRows = page.locator('#repo-issue-ranking .rank-row');
      await expect(issueRows).toHaveCount(1);
      await expect(issueRows.first()).toContainText('alrayyes/issue-heavy');
      await expect(issueRows.first().locator('.rank-count')).toHaveText('2');
    });

    test('says how many more repos exist once the ranking is capped', async ({
      page,
    }) => {
      const pullRequests = Array.from({ length: 12 }, (_, i) =>
        prsForRepo(`alrayyes/repo-${i}`, 1),
      ).flat();
      await mockDashboard(page, { pullRequests });

      await page.goto('/insights.html');

      await expect(page.locator('#repo-pr-ranking .rank-row')).toHaveCount(10);
      await expect(page.locator('#repo-pr-ranking-more')).toContainText(
        '2 more',
      );
    });

    test('shows an explicit empty state for each list independently', async ({
      page,
    }) => {
      await mockDashboard(page, { pullRequests: [], issues: [] });

      await page.goto('/insights.html');

      await expect(page.locator('#repo-pr-ranking-empty')).toBeVisible();
      await expect(page.locator('#repo-issue-ranking-empty')).toBeVisible();
    });
  });

  test.describe('pull request age', () => {
    test('buckets open pull requests by age, each bar directly labeled with its count', async ({
      page,
    }) => {
      await mockDashboard(page, {
        pullRequests: [
          pr('success', { number: 1, createdAt: hoursAgo(2) }), // <1 day
          pr('success', { number: 2, createdAt: hoursAgo(48) }), // 1-3 days
          pr('success', { number: 3, createdAt: hoursAgo(48) }), // 1-3 days
          pr('success', { number: 4, createdAt: hoursAgo(24 * 5) }), // 3-7 days
          pr('success', { number: 5, createdAt: hoursAgo(24 * 15) }), // 7-30 days
        ],
      });

      await page.goto('/insights.html');

      await expect(
        page.locator('[data-age-bucket="lt1"] .age-count'),
      ).toHaveText('1');
      await expect(
        page.locator('[data-age-bucket="1to3"] .age-count'),
      ).toHaveText('2');
      await expect(
        page.locator('[data-age-bucket="3to7"] .age-count'),
      ).toHaveText('1');
      await expect(
        page.locator('[data-age-bucket="7to30"] .age-count'),
      ).toHaveText('1');
      await expect(
        page.locator('[data-age-bucket="30plus"] .age-count'),
      ).toHaveText('0');
    });

    test('a pull request older than every named bucket falls into the final 30+ days bucket, not dropped', async ({
      page,
    }) => {
      await mockDashboard(page, {
        pullRequests: [pr('success', { createdAt: hoursAgo(24 * 400) })],
      });

      await page.goto('/insights.html');

      await expect(
        page.locator('[data-age-bucket="30plus"] .age-count'),
      ).toHaveText('1');
    });

    test('shows an explicit empty state with no open pull requests', async ({
      page,
    }) => {
      await mockDashboard(page, { pullRequests: [] });

      await page.goto('/insights.html');

      await expect(page.locator('#pr-age-empty')).toBeVisible();
      await expect(page.locator('#pr-age-chart')).toBeHidden();
    });
  });

  test('has no axe-core violations at desktop width, with real chart content present', async ({
    page,
  }) => {
    await mockDashboard(page, {
      pullRequests: [
        pr('success'),
        pr('failure'),
        pr('pending'),
        pr('none', { repo: 'alrayyes/other' }),
      ],
      issues: [issue(), issue({ repo: 'alrayyes/other', number: 2 })],
    });
    await page.goto('/insights.html');
    await expect(
      page.locator('[data-ci-status="success"] .ci-count'),
    ).toHaveText('1');
    await expect(page.locator('#repo-pr-ranking .rank-row')).toHaveCount(2);

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
      pullRequests: [
        pr('success'),
        pr('failure'),
        pr('pending'),
        pr('none', { repo: 'alrayyes/other' }),
      ],
      issues: [issue(), issue({ repo: 'alrayyes/other', number: 2 })],
    });
    await page.goto('/insights.html');
    await expect(
      page.locator('[data-ci-status="success"] .ci-count'),
    ).toHaveText('1');
    await expect(page.locator('#repo-pr-ranking .rank-row')).toHaveCount(2);

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
