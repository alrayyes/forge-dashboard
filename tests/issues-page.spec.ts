import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #827: issues have their own page, /issues.html, with a nav item and a
// count badge. The pull request page no longer lists them.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `issues-page-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Issues Page User');
}

interface MockIssue {
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  labels: { name: string; color: string }[];
  createdAt: string;
  updatedAt: string;
}

function makeIssue(number: number, overrides: Partial<MockIssue> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'alrayyes',
    labels: [],
    createdAt: new Date(Date.now() - number * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    ...overrides,
  };
}

function makePR(number: number) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pulls/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: false,
  };
}

// 12 real issues plus the Renovate dashboard, which the board hides by
// default and the badge therefore leaves out.
const ISSUES = [
  ...Array.from({ length: 12 }, (_, i) =>
    makeIssue(i + 1, {
      repo: i < 7 ? 'alrayyes/forge-dashboard' : 'alrayyes/other-repo',
      title: i === 4 ? 'Needle in the haystack' : `Issue ${i + 1}`,
    }),
  ),
  makeIssue(99, { title: 'Dependency Dashboard', author: 'renovate[bot]' }),
];

async function mockDashboard(page: Page, issues = ISSUES) {
  // The real stream would push the server's own (empty) snapshot over the
  // mocked one after a reload.
  await page.route('**/api/dashboard/stream', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [makePR(1), makePR(2)],
        issues,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.reload();
}

const issuesLink = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', {
    name: /^Issues/,
  });

test.describe('issues page (#827)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('the nav has an Issues item with a count badge, on both pages', async ({
    page,
  }) => {
    await mockDashboard(page);

    await expect(issuesLink(page)).toBeVisible();
    await expect(issuesLink(page).locator('.nav-badge')).toHaveText('12');
    await expect(issuesLink(page)).toHaveAttribute(
      'aria-label',
      'Issues, 12 open',
    );

    await issuesLink(page).click();
    await expect(page).toHaveURL(/\/issues\.html$/);
    await expect(issuesLink(page).locator('.nav-badge')).toHaveText('12');
    await expect(issuesLink(page)).toHaveAttribute('aria-current', 'page');
  });

  test('the mobile navigation has the Issues item too', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockDashboard(page);

    const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(mobile.getByRole('link', { name: /^Issues/ })).toBeVisible();
  });

  test('the pull request page no longer lists issues', async ({ page }) => {
    await mockDashboard(page);

    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
    await expect(page.locator('#issue-rows')).toHaveCount(0);
    await expect(page.locator('section[aria-label="Open issues"]')).toHaveCount(
      0,
    );
  });

  test('/issues.html lists the open issues and not the pull requests', async ({
    page,
  }) => {
    await mockDashboard(page);
    await page.goto('/issues.html');

    await expect(page.locator('#issue-rows > .row')).toHaveCount(12);
    await expect(page.locator('#pr-rows')).toHaveCount(0);
    await expect(page.locator('#issue-count')).toContainText('12');
  });

  test('the issues page filters like pull requests: repo, title, author, label, forge', async ({
    page,
  }) => {
    await mockDashboard(page);
    await page.goto('/issues.html');
    await expect(page.locator('#issue-rows > .row')).toHaveCount(12);

    await page.locator('#shared-repo-select').selectOption({
      label: 'alrayyes/other-repo',
    });
    await expect(page.locator('#issue-rows > .row')).toHaveCount(5);

    await page.locator('#shared-repo-select').selectOption({ index: 0 });
    await page
      .getByRole('combobox', { name: 'Filter by title' })
      .fill('Needle');
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(page.locator('#issue-rows > .row')).toContainText('Needle');

    for (const id of [
      '#shared-author-select',
      '#shared-label-select',
      '[data-col="created"]',
      '[data-col="updated"]',
    ]) {
      await expect(page.locator(id)).toBeVisible();
    }
  });

  test('a filter set on one page is still set on the other, and survives a reload', async ({
    page,
  }) => {
    await mockDashboard(page);
    await page.goto('/issues.html');
    await page.locator('#shared-repo-select').selectOption({
      label: 'alrayyes/other-repo',
    });
    await expect(page.locator('#issue-rows > .row')).toHaveCount(5);

    await page.reload();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(5);
  });

  for (const [name, size] of [
    ['desktop', { width: 1280, height: 800 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    for (const path of ['/', '/issues.html']) {
      test(`${path} has no axe violations at ${name} width`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await mockDashboard(page);
        await page.goto(path);
        await expect(page.locator('.row').first()).toBeVisible();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
