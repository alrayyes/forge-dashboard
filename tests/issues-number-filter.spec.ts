import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { landOnPullRequests, test } from './server-fixture';

// The Issues page's title box also takes a ticket number: `1884` or `#1884`.
// It is the same box and the same saved filter as the title search, so it
// survives leaving the page like every other filter (#1620).
// https://github.com/alrayyes/forge-dashboard/issues/2155
// https://github.com/alrayyes/forge-dashboard/issues/1620

function issue(number: number, repo: string, title: string) {
  return {
    forge: 'github',
    repo,
    number,
    title,
    url: `https://example.com/${repo}/issues/${number}`,
    author: 'alrayyes',
    labels: [],
    createdAt: new Date(Date.now() - number * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
  };
}

// 1884 exists in two repos, 18 and 188 are shorter numbers, and one title
// carries "2024" so a bare number still searches titles.
const ISSUES = [
  issue(1884, 'acme/app', 'Sync stalls'),
  issue(1884, 'acme/docs', 'Typo in the guide'),
  issue(188, 'acme/app', 'Dark mode'),
  issue(18, 'acme/app', 'Login flicker'),
  issue(7, 'acme/app', 'Roadmap for 2024'),
  issue(2024, 'acme/docs', 'Year rollover'),
];

const PULL_REQUESTS = [
  {
    forge: 'github',
    repo: 'acme/app',
    number: 5,
    title: 'A pull request',
    url: 'https://example.com/acme/app/pull/5',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
  },
];

async function open(page: Page, path = '/issues.html') {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: PULL_REQUESTS,
        issues: ISSUES,
        repos: [],
        hiddenDrafts: 0,
        navCounts: navCountsFor(PULL_REQUESTS, ISSUES.length),
      }),
    }),
  );
  await page.goto(path);
}

const rows = (page: Page) => page.locator('#issue-rows > .row');
const box = (page: Page) =>
  page.getByRole('combobox', { name: 'Filter by title' });

test.describe('filter the Issues page by ticket number (2155)', () => {
  test.beforeEach(async ({ page }) => {
    await landOnPullRequests(page);
    await open(page);
    await expect(rows(page)).toHaveCount(ISSUES.length);
  });

  for (const term of ['1884', '#1884']) {
    test(`typing ${term} lists that number from every repo and counts it`, async ({
      page,
    }) => {
      await box(page).fill(term);
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).nth(0)).toContainText('#1884');
      await expect(rows(page).nth(1)).toContainText('#1884');
      await expect(page.locator('#issue-count')).toContainText('2');
    });
  }

  test('a partial number matches numbers that start with it', async ({
    page,
  }) => {
    await box(page).fill('18');
    await expect(rows(page)).toHaveCount(4);
    await box(page).fill('#18');
    await expect(rows(page)).toHaveCount(4);
  });

  test('a # term matches numbers only, a bare number still matches titles', async ({
    page,
  }) => {
    await box(page).fill('#2024');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText('Year rollover');

    await box(page).fill('2024');
    await expect(rows(page)).toHaveCount(2);
  });

  test('a text term still filters by title', async ({ page }) => {
    await box(page).fill('guide');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText('Typo in the guide');
  });

  test('a number that matches nothing shows the empty state, and clear restores the list', async ({
    page,
  }) => {
    await box(page).fill('#999999');
    await expect(rows(page)).toHaveCount(0);
    await expect(
      page.getByText('No issues match these filters.'),
    ).toBeVisible();

    await page.locator('#clear-filters-button').click();
    await expect(rows(page)).toHaveCount(ISSUES.length);
    await expect(box(page)).toHaveValue('');
  });

  test('the number filter survives a reload and a visit to another page', async ({
    page,
  }) => {
    await box(page).fill('#1884');
    await expect(rows(page)).toHaveCount(2);

    await page.reload();
    await expect(box(page)).toHaveValue('#1884');
    await expect(rows(page)).toHaveCount(2);

    await page.locator('.app-nav a[href="/pull-requests.html"]').click();
    await page.locator('.app-nav a[href="/issues.html"]').click();
    await expect(box(page)).toHaveValue('#1884');
    await expect(rows(page)).toHaveCount(2);
  });

  test('the box is reachable by keyboard and says it takes numbers', async ({
    page,
  }) => {
    await expect(box(page)).toHaveAccessibleName(/title/i);
    await expect(box(page)).toHaveAttribute('placeholder', 'Title or #number');
    await box(page).focus();
    await expect(box(page)).toBeFocused();
    await page.keyboard.type('#188');
    await expect(rows(page)).toHaveCount(3);
  });

  test('has no axe violations with a number filter applied', async ({
    page,
  }) => {
    await box(page).fill('#1884');
    await expect(rows(page)).toHaveCount(2);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
