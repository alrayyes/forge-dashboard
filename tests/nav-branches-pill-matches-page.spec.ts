import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Branches nav pill and the Main branches page chips are one tally. The
// page reads /api/main-branches on its own timer and the pill reads the
// dashboard snapshot on another, so a default branch whose run had only just
// failed (a job red, the pipeline still going a moment before) showed Failed on
// the page while the pill still counted it as running.
// https://github.com/alrayyes/forge-dashboard/issues/2579

type Status = 'failed' | 'running' | 'passed' | 'none';

function row(fullName: string, status: Status) {
  return {
    forge: 'github',
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status,
    commit: {
      sha: 'd98f3c2',
      subject: `fix: change in ${fullName}`,
      author: 'sre-dev',
      committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    failingJobs: status === 'failed' ? ['release-please'] : [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
    staleSince: null,
  };
}

const BRANCHES = [
  row('acme/php', 'failed'),
  row('acme/node', 'failed'),
  row('acme/go', 'running'),
  row('acme/python', 'running'),
  row('acme/app', 'running'),
  row('acme/docs', 'running'),
  row('acme/lib', 'passed'),
  row('acme/new', 'none'),
];

// What the pill's snapshot said a poll ago: node's run was still going.
const OLDER_NAV = {
  total: 8,
  failed: 1,
  running: 5,
  passed: 1,
  none: 1,
  awaitingApproval: 0,
};

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 8 }],
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
        navCounts: {
          branches: OLDER_NAV,
          pullRequests: { total: 0, failed: 0, running: 0, passed: 0 },
          issues: { total: 0 },
          releases: { total: 0, failed: 0, running: 0, passed: 0 },
          bots: { total: 0, failed: 0, running: 0, passed: 0 },
        },
      }),
    }),
  );
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 2,
          passed: 1,
          running: 4,
          cancelled: 0,
          awaitingApproval: 0,
          none: 1,
          total: BRANCHES.length,
        },
        forges: [],
        branches: BRANCHES,
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
    BRANCHES.length,
  );
}

const pill = (page: Page) =>
  page.locator('header nav a[href="/"]').locator('.nav-pills');
const chip = (page: Page, name: string) =>
  page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name })
    .locator('.mb-count');

test.describe('the Branches nav pill matches the page chips (#2579)', () => {
  test('failing, running, passing and no pipeline read the same in both', async ({
    page,
  }) => {
    await open(page);

    for (const [name, kind] of [
      ['All', 'total'],
      ['Failing', 'failed'],
      ['Running', 'running'],
      ['Passing', 'passed'],
      ['No pipeline', 'none'],
    ] as const) {
      const onPage = (await chip(page, name).textContent())?.trim();
      await expect(pill(page).locator(`.nav-${kind}`)).toHaveText(onPage ?? '');
    }
    await expect(pill(page).locator('.nav-failed')).toHaveText('2');
    await expect(pill(page).locator('.nav-running')).toHaveText('4');
  });

  test('has no axe-core violations in the light and dark themes', async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    }
  });
});
