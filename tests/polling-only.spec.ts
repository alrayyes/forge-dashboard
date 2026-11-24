import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Repos with no confirmed webhook refresh on a schedule. Settings,
// Repositories and Branches say so, and why (#4028).

const repo = (
  forge: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  forge,
  fullName: `demo/${name}`,
  url: `https://example.com/demo/${name}`,
  hasWebhook: true,
  canManageWebhooks: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  rebaseBots: false,
  ...extra,
});

const json = (body: object) => (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

async function mockDashboard(
  page: Page,
  repos: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route(
    '**/api/v1/dashboard*',
    json({
      generatedAt: new Date().toISOString(),
      forges: [forgeHealth('github'), forgeHealth('forgejo')],
      pullRequests: [],
      issues: [],
      repos,
      ...extra,
    }),
  );
}

const branch = (forge: string, name: string) => ({
  forge,
  fullName: `demo/${name}`,
  url: `https://example.com/demo/${name}`,
  branch: 'main',
  status: 'passed',
  commit: {
    sha: 'd98f3c2',
    subject: 'fix: a change',
    author: 'dev',
    committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  },
  failingJobs: [],
  finishedAt: null,
  durationSeconds: null,
  runUrl: `https://example.com/demo/${name}/actions/runs/1`,
  checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
  latestRelease: null,
  staleSince: null,
  advisories: { state: 'unknown', count: 0, highest: null, url: '' },
});

async function mockBranches(page: Page, rows: ReturnType<typeof branch>[]) {
  await page.route(
    '**/api/v1/main-branches',
    json({
      generatedAt: new Date().toISOString(),
      counts: {
        failed: 0,
        passed: rows.length,
        running: 0,
        cancelled: 0,
        awaitingApproval: 0,
        none: 0,
        total: rows.length,
      },
      branches: rows,
    }),
  );
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const REPOS = [
  repo('github', 'live'),
  repo('github', 'no-token', { hasWebhook: false, canManageWebhooks: false }),
  repo('forgejo', 'unreachable', { hasWebhook: false }),
  repo('forgejo', 'ignored', { hasWebhook: false, ignored: true }),
];

test.describe('settings, repositories: polling only', () => {
  test('the notice counts the repos and is not drawn at zero', async ({
    page,
  }) => {
    await mockDashboard(page, REPOS);
    await page.goto('/settings.html#repositories');
    await expect(page.locator('#repositories-polling')).toContainText(
      '2 repos refresh on a schedule instead of instantly',
    );
    await page.unroute('**/api/v1/dashboard*');
    await mockDashboard(page, [repo('github', 'live')]);
    await page.reload();
    await expect(page.locator('#repositories-rows tr')).toHaveCount(1);
    await expect(page.locator('#repositories-polling')).toHaveCount(0);
  });

  test('one repo is singular', async ({ page }) => {
    await mockDashboard(page, [
      repo('github', 'live'),
      repo('github', 'poll', { hasWebhook: false }),
    ]);
    await page.goto('/settings.html#repositories');
    await expect(page.locator('#repositories-polling')).toContainText(
      '1 repo refreshes on a schedule instead of instantly',
    );
  });

  test('Show only these is ANDed with forge and search, and Clear filters undoes it', async ({
    page,
  }) => {
    await mockDashboard(page, REPOS);
    await page.goto('/settings.html#repositories');
    const rows = page.locator('#repositories-rows tr');
    await expect(rows).toHaveCount(3);
    const pill = page.getByRole('button', { name: 'Show only these' });
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(2);
    await page.getByRole('button', { name: /^Forgejo/ }).click();
    await expect(rows).toHaveCount(1);
    await page.locator('#repositories-search').fill('live');
    await expect(page.locator('#repositories-no-results')).toContainText(
      'No repos match these filters',
    );
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows).toHaveCount(3);
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
  });

  test('each polling row says why and where to fix it', async ({ page }) => {
    await mockDashboard(page, REPOS);
    await page.goto('/settings.html#repositories');
    const token = page
      .locator('#repositories-rows tr')
      .filter({ hasText: 'demo/no-token' });
    await expect(token).toContainText(
      'Polling only: your token cannot manage webhooks here.',
    );
    await expect(
      token.getByRole('link', { name: 'Fix in Connections' }),
    ).toHaveAttribute('href', '/settings.html#connections');
    await expect(
      page.locator('#repositories-rows tr').filter({ hasText: 'demo/live' }),
    ).not.toContainText('Polling only');
  });

  test('an unreachable address says the forge cannot reach the dashboard', async ({
    page,
  }) => {
    await mockDashboard(page, REPOS, {
      webhookOriginProblem: 'the address is private',
    });
    await page.goto('/settings.html#repositories');
    const row = page
      .locator('#repositories-rows tr')
      .filter({ hasText: 'demo/unreachable' });
    await expect(row).toContainText(
      'Polling only: the forge cannot reach this dashboard.',
    );
    await expect(
      row.getByRole('link', { name: 'See the guide' }),
    ).toHaveAttribute('href', /docs\/webhooks\.md#polling-only$/);
  });

  test('a deep link scrolls the pill into view', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    const many = Array.from({ length: 20 }, (_, i) => repo('github', `r${i}`));
    await mockDashboard(page, [
      ...many,
      repo('github', 'poll', { hasWebhook: false }),
    ]);
    await page.goto('/settings.html#repositories');
    const pill = page.getByRole('button', { name: 'Show only these' });
    await expect(pill).toBeInViewport();
  });

  test('axe is clean on desktop and phone, light and dark', async ({
    page,
  }) => {
    await mockDashboard(page, REPOS);
    await page.goto('/settings.html#repositories');
    await expect(page.locator('#repositories-polling')).toBeVisible();
    await expectNoAxeViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoAxeViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoAxeViolations(page);
  });
});

test.describe('branches: polling only', () => {
  test('a polling repo wears a chip that links to Settings, apart from the forge chip', async ({
    page,
  }) => {
    await mockDashboard(page, REPOS);
    await mockBranches(page, [
      branch('github', 'live'),
      branch('forgejo', 'unreachable'),
    ]);
    await page.goto('/');
    const rows = page.getByTestId('main-branch-row');
    await expect(rows).toHaveCount(2);
    const chip = rows
      .filter({ hasText: 'demo/unreachable' })
      .getByTestId('polling-only-chip');
    await expect(chip).toContainText('Polling only');
    await expect(
      chip.getByRole('link', { name: 'See why in Settings' }),
    ).toHaveAttribute('href', '/settings.html#repositories');
    await expect(
      rows.filter({ hasText: 'demo/live' }).getByTestId('polling-only-chip'),
    ).toHaveCount(0);
    await expect(page.locator('#mb-polling')).toContainText(
      '2 repos refresh on a schedule instead of instantly',
    );
  });

  test('Show only these narrows the list, Clear filters undoes it, axe is clean', async ({
    page,
  }) => {
    await mockDashboard(page, REPOS);
    await mockBranches(page, [
      branch('github', 'live'),
      branch('forgejo', 'unreachable'),
    ]);
    await page.goto('/');
    const rows = page.getByTestId('main-branch-row');
    await expect(rows).toHaveCount(2);
    const pill = page.getByRole('button', { name: 'Show only these' });
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(1);
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows).toHaveCount(2);
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
  });

  test('no notice when every repo has a hook', async ({ page }) => {
    await mockDashboard(page, [repo('github', 'live')]);
    await mockBranches(page, [branch('github', 'live')]);
    await page.goto('/');
    await expect(page.getByTestId('main-branch-row')).toHaveCount(1);
    await expect(page.locator('#mb-polling')).toHaveCount(0);
  });
});
