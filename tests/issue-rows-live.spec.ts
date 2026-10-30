import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { pushChecks, serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

// The Issues page follows the jobs of the pull requests its rows link, so the
// pipeline on a row's pill reads the same list the pull request's own row and
// dialog would, without waiting for the next refresh. Which pull requests are
// watched is unit-tested (pr-row-watch.test.ts) and how a list folds into a
// pill is too (pr-fold.test.ts); this proves the page wires them together.

const REPO = 'alrayyes/forge-dashboard';

const PASSED = [
  {
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.com/r/1',
  },
  {
    name: 'test',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.com/r/2',
  },
];

const FAILED = [
  {
    name: 'build',
    status: 'completed',
    conclusion: 'failure',
    url: 'https://example.com/r/1',
  },
];

const linked = (number: number) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'pending',
  checks: { passed: 1, running: 1, waiting: 0, failed: 0 },
  awaitingWorkflowApproval: false,
});

const issue = (number: number, prNumber: number) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [],
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000 * number).toISOString(),
  linkedPullRequests: [linked(prNumber)],
});

async function serveBoard(page: Page, issues: unknown[]) {
  await page.route('**/api/v1/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues,
      }),
    }),
  );
}

const subjectOf = (number: number) => ({
  kind: 'pull_request' as const,
  forge: 'github',
  fullName: REPO,
  number,
});

const pill = (page: Page, number: number) =>
  page
    .locator('#issue-rows .row', { hasText: `Issue ${number}` })
    .locator('.linked-pr');

test.describe('issue rows follow the jobs of the pull requests they link', () => {
  test('a pill reads its live jobs, and a pushed list moves it', async ({
    page,
  }) => {
    const feed = await serveChecks(page, () => PASSED);
    await serveBoard(page, [issue(1, 12)]);
    await page.goto('/issues.html');

    await expect(pill(page, 1)).toContainText('Passed');
    await feed.idle();
    expect(feed.asked).toHaveLength(1);

    await pushChecks(page, subjectOf(12), FAILED);
    await expect(pill(page, 1)).toContainText('Failed');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a fold that lands while updates are paused draws when they resume', async ({
    page,
  }) => {
    const feed = await serveChecks(page, () => PASSED);
    await serveBoard(page, [issue(1, 12)]);
    await page.goto('/issues.html');
    await expect(pill(page, 1)).toContainText('Passed');
    await feed.idle();

    await page.locator('#pause-updates-button').click();
    await pushChecks(page, subjectOf(12), FAILED);
    await expect(pill(page, 1)).toContainText('Passed');

    await page.locator('#pause-updates-button').click();
    await expect(pill(page, 1)).toContainText('Failed');
  });
});
