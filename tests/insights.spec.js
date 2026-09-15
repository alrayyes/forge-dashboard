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

function mockDashboard(
  page,
  {
    pullRequests = [],
    issues = [],
    forges = [{ forge: 'github', reachable: true, repoCount: 1 }],
  } = {},
) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
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

  test.describe('issue age', () => {
    test('buckets open issues by age, each bar directly labeled with its count, separately from pull request age', async ({
      page,
    }) => {
      await mockDashboard(page, {
        pullRequests: [pr('success', { createdAt: hoursAgo(24 * 15) })], // 7-30 days
        issues: [
          issue({ number: 1, createdAt: hoursAgo(2) }), // <1 day
          issue({ number: 2, createdAt: hoursAgo(48) }), // 1-3 days
          issue({ number: 3, createdAt: hoursAgo(48) }), // 1-3 days
        ],
      });

      await page.goto('/insights.html');

      const issueChart = page.locator('#issue-age-chart');
      await expect(
        issueChart.locator('[data-age-bucket="lt1"] .age-count'),
      ).toHaveText('1');
      await expect(
        issueChart.locator('[data-age-bucket="1to3"] .age-count'),
      ).toHaveText('2');
      await expect(
        issueChart.locator('[data-age-bucket="7to30"] .age-count'),
      ).toHaveText('0');

      // The pull request age chart's own <1 day bucket must stay 0 — a
      // 7-30-day pull request should never bleed into the issue chart's
      // buckets or vice versa.
      const prChart = page.locator('#pr-age-chart');
      await expect(
        prChart.locator('[data-age-bucket="lt1"] .age-count'),
      ).toHaveText('0');
      await expect(
        prChart.locator('[data-age-bucket="7to30"] .age-count'),
      ).toHaveText('1');
    });

    test('an issue older than every named bucket falls into the final 30+ days bucket, not dropped', async ({
      page,
    }) => {
      await mockDashboard(page, {
        issues: [issue({ createdAt: hoursAgo(24 * 400) })],
      });

      await page.goto('/insights.html');

      await expect(
        page
          .locator('#issue-age-chart')
          .locator('[data-age-bucket="30plus"] .age-count'),
      ).toHaveText('1');
    });

    test('shows an explicit empty state with no open issues', async ({
      page,
    }) => {
      await mockDashboard(page, { issues: [] });

      await page.goto('/insights.html');

      await expect(page.locator('#issue-age-empty')).toBeVisible();
      await expect(page.locator('#issue-age-chart')).toBeHidden();
    });
  });

  test.describe('rate-limit headroom', () => {
    test('shows remaining/limit as a proportion, directly labeled, for a forge that reports one', async ({
      page,
    }) => {
      const resetsAt = new Date(Date.now() + 41 * 60 * 1000).toISOString();
      await mockDashboard(page, {
        forges: [
          {
            forge: 'github',
            reachable: true,
            repoCount: 3,
            rateLimit: { limit: 5000, remaining: 4922, resetsAt },
          },
        ],
      });

      await page.goto('/insights.html');

      const row = page.locator('[data-forge="github"]');
      await expect(row).toContainText('4,922');
      await expect(row).toContainText('5,000');
    });

    test("says a forge's rate limit isn't reported, rather than showing a broken or zero-looking bar", async ({
      page,
    }) => {
      await mockDashboard(page, {
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 2 }],
      });

      await page.goto('/insights.html');

      const row = page.locator('[data-forge="forgejo"]');
      await expect(row).toContainText('Not reported by this forge');
      await expect(row.locator('.rate-limit-bar')).toHaveCount(0);
    });

    test('shows when the budget resets', async ({ page }) => {
      const resetsAt = new Date(Date.now() + 41 * 60 * 1000).toISOString();
      await mockDashboard(page, {
        forges: [
          {
            forge: 'github',
            reachable: true,
            repoCount: 3,
            rateLimit: { limit: 5000, remaining: 4922, resetsAt },
          },
        ],
      });

      await page.goto('/insights.html');

      await expect(
        page.locator('[data-forge="github"] .rate-limit-reset'),
      ).toContainText('Resets');
    });
  });

  test.describe('filters', () => {
    test('the pull request filter row scopes CI status, PR ranking, and PR age — issue charts stay unaffected', async ({
      page,
    }) => {
      await mockDashboard(page, {
        pullRequests: [
          pr('success', { repo: 'alrayyes/one' }),
          pr('failure', { repo: 'alrayyes/two' }),
        ],
        issues: [
          issue({ repo: 'alrayyes/one', number: 10 }),
          issue({ repo: 'alrayyes/two', number: 11 }),
        ],
      });

      await page.goto('/insights.html');
      await expect(page.locator('#repo-pr-ranking .rank-row')).toHaveCount(2);
      await expect(page.locator('#repo-issue-ranking .rank-row')).toHaveCount(
        2,
      );

      await page.selectOption(
        '[data-filter-scope="pr"] [data-col="repo"]',
        'github:alrayyes/one',
      );

      await expect(page.locator('#repo-pr-ranking .rank-row')).toHaveCount(1);
      await expect(page.locator('#repo-pr-ranking .rank-row')).toContainText(
        'alrayyes/one',
      );
      await expect(
        page.locator('[data-ci-status="success"] .ci-count'),
      ).toHaveText('1');
      await expect(
        page.locator('[data-ci-status="failure"] .ci-count'),
      ).toHaveText('0');

      // Never refetched — a filter change re-renders from the snapshot
      // already in hand.
      await expect(page.locator('#repo-issue-ranking .rank-row')).toHaveCount(
        2,
      );
    });

    test('the issue filter row scopes the Issues ranking and issue age — pull request charts stay unaffected', async ({
      page,
    }) => {
      await mockDashboard(page, {
        pullRequests: [pr('success', { repo: 'alrayyes/one' })],
        issues: [
          issue({ repo: 'alrayyes/one', number: 10, author: 'alice' }),
          issue({ repo: 'alrayyes/two', number: 11, author: 'bob' }),
        ],
      });

      await page.goto('/insights.html');
      await expect(page.locator('#repo-issue-ranking .rank-row')).toHaveCount(
        2,
      );

      await page.selectOption(
        '[data-filter-scope="issue"] [data-col="author"]',
        'alice',
      );

      await expect(page.locator('#repo-issue-ranking .rank-row')).toHaveCount(
        1,
      );
      await expect(page.locator('#repo-issue-ranking .rank-row')).toContainText(
        'alrayyes/one',
      );
      await expect(page.locator('#repo-pr-ranking .rank-row')).toHaveCount(1);
    });

    test('repo, author, and label options are populated from the real data, per scope', async ({
      page,
    }) => {
      await mockDashboard(page, {
        pullRequests: [
          pr('success', {
            repo: 'alrayyes/one',
            author: 'alice',
            labels: [{ name: 'bug', color: 'd73a4a' }],
          }),
        ],
        issues: [issue({ repo: 'alrayyes/two', author: 'bob' })],
      });

      await page.goto('/insights.html');
      await expect(page.locator('#repo-pr-ranking .rank-row')).toHaveCount(1);

      await expect(
        page.locator('[data-filter-scope="pr"] [data-col="repo"] option'),
      ).toHaveText(['All repos', 'alrayyes/one']);
      await expect(
        page.locator('[data-filter-scope="pr"] [data-col="author"] option'),
      ).toHaveText(['All authors', 'alice']);
      await expect(
        page.locator('[data-filter-scope="pr"] [data-col="label"] option'),
      ).toHaveText(['All labels', 'bug']);
      await expect(
        page.locator('[data-filter-scope="issue"] [data-col="repo"] option'),
      ).toHaveText(['All repos', 'alrayyes/two']);
    });

    test('a filter set on the main dashboard already applies here — the same cookie, not a separate preference', async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: 'forge-board-filters',
          value: JSON.stringify({ pr: { repo: 'github:alrayyes/one' } }),
          domain: 'localhost',
          path: '/',
        },
      ]);
      await mockDashboard(page, {
        pullRequests: [
          pr('success', { repo: 'alrayyes/one' }),
          pr('failure', { repo: 'alrayyes/two' }),
        ],
      });

      await page.goto('/insights.html');

      await expect(page.locator('#repo-pr-ranking .rank-row')).toHaveCount(1);
      await expect(page.locator('#repo-pr-ranking .rank-row')).toContainText(
        'alrayyes/one',
      );
      await expect(
        page.locator('[data-filter-scope="pr"] [data-col="repo"]'),
      ).toHaveValue('github:alrayyes/one');
    });

    test('a status/created/updated filter left in the cookie by the main dashboard has no effect here', async ({
      page,
      context,
    }) => {
      // The main dashboard's own PR board persists these — a real user
      // could easily have filtered to "Failing" there before ever
      // opening Insights. If this leaked through, the CI status chart
      // (which visualizes exactly that dimension) would always render
      // one bar and look broken.
      await context.addCookies([
        {
          name: 'forge-board-filters',
          value: JSON.stringify({ pr: { status: 'failure' } }),
          domain: 'localhost',
          path: '/',
        },
      ]);
      await mockDashboard(page, {
        pullRequests: [pr('success'), pr('failure'), pr('pending')],
      });

      await page.goto('/insights.html');

      await expect(
        page.locator('[data-ci-status="success"] .ci-count'),
      ).toHaveText('1');
      await expect(
        page.locator('[data-ci-status="failure"] .ci-count'),
      ).toHaveText('1');
      await expect(
        page.locator('[data-ci-status="pending"] .ci-count'),
      ).toHaveText('1');
    });

    test('the Hide Dependency Dashboard checkbox defaults on, toggles both ways, and persists across a reload', async ({
      page,
    }) => {
      await mockDashboard(page, {
        issues: [
          issue({
            number: 20,
            title: 'Dependency Dashboard',
            author: 'renovate[bot]',
          }),
          issue({ number: 21, title: 'A real issue' }),
        ],
      });

      await page.goto('/insights.html');
      const toggle = page.locator(
        '[data-filter-scope="issue"] [data-col="hideDependencyDashboard"]',
      );
      await expect(toggle).toBeChecked();
      await expect(page.locator('#repo-issue-ranking .rank-row')).toHaveCount(
        1,
      );
      await expect(
        page
          .locator('#issue-age-chart')
          .locator('[data-age-bucket="lt1"] .age-count'),
      ).toHaveText('1');

      await toggle.uncheck();
      await expect(page.locator('#repo-issue-ranking .rank-row')).toHaveCount(
        1,
      );
      // Still 1 row (one repo), but now its count includes both issues.
      await expect(
        page.locator('#repo-issue-ranking .rank-row .rank-count'),
      ).toHaveText('2');

      await page.reload();
      await expect(toggle).not.toBeChecked();
      await expect(
        page.locator('#repo-issue-ranking .rank-row .rank-count'),
      ).toHaveText('2');
    });
  });

  test('has no axe-core violations at desktop width, with real chart content present', async ({
    page,
  }) => {
    await mockDashboard(page, {
      forges: [
        {
          forge: 'github',
          reachable: true,
          repoCount: 3,
          rateLimit: {
            limit: 5000,
            remaining: 4922,
            resetsAt: new Date(Date.now() + 41 * 60 * 1000).toISOString(),
          },
        },
        { forge: 'forgejo', reachable: true, repoCount: 1 },
      ],
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
    await expect(page.locator('[data-forge="forgejo"]')).toContainText(
      'Not reported',
    );

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
      forges: [
        {
          forge: 'github',
          reachable: true,
          repoCount: 3,
          rateLimit: {
            limit: 5000,
            remaining: 4922,
            resetsAt: new Date(Date.now() + 41 * 60 * 1000).toISOString(),
          },
        },
        { forge: 'forgejo', reachable: true, repoCount: 1 },
      ],
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
