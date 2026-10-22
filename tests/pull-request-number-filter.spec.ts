import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// The title box on the Pull requests and Bot PRs pages also takes a number,
// the way the Issues page's box does: `2509` or `#2509`, matching numbers that
// start with it, and titles as before.
// https://github.com/alrayyes/forge-dashboard/issues/2514

function pr(
  number: number,
  repo: string,
  title: string,
  kind: 'regular' | 'dependency' = 'regular',
) {
  return {
    forge: 'github',
    repo,
    number,
    title,
    url: `https://example.com/${repo}/pull/${number}`,
    author: kind === 'dependency' ? 'dependabot' : 'alrayyes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date(Date.now() - number * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind,
  };
}

const PULL_REQUESTS = [
  pr(2509, 'acme/app', 'Sync stalls'),
  pr(250, 'acme/docs', 'Typo in the guide'),
  pr(25, 'acme/app', 'Login flicker'),
  pr(7, 'acme/app', 'Roadmap for 2024'),
  pr(2024, 'acme/docs', 'Year rollover'),
  pr(3101, 'acme/app', 'Bump left-pad from 1.0.0 to 1.0.1', 'dependency'),
  pr(3102, 'acme/app', 'Bump right-pad from 1.0.0 to 1.0.1', 'dependency'),
  pr(310, 'acme/docs', 'Bump up-pad from 1.0.0 to 1.0.1', 'dependency'),
];

async function open(page: Page, path: string) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: PULL_REQUESTS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
        navCounts: navCountsFor(PULL_REQUESTS, 0),
      }),
    }),
  );
  await page.goto(path);
}

const rows = (page: Page) => page.locator('#pr-rows > .row');
const box = (page: Page) =>
  page.getByRole('combobox', { name: 'Filter by title' });

test.describe('filter the Pull requests page by number (2514)', () => {
  test.beforeEach(async ({ page }) => {
    await open(page, '/pull-requests.html');
    await expect(rows(page)).toHaveCount(5);
  });

  for (const term of ['2509', '#2509']) {
    test(`typing ${term} lists only that pull request`, async ({ page }) => {
      await box(page).fill(term);
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page)).toContainText('Sync stalls');
    });
  }

  test('a partial number matches numbers that start with it', async ({
    page,
  }) => {
    await box(page).fill('25');
    await expect(rows(page)).toHaveCount(3);
    await box(page).fill('#25');
    await expect(rows(page)).toHaveCount(3);
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
  });

  test('a number that matches nothing shows the empty state', async ({
    page,
  }) => {
    await box(page).fill('#999999');
    await expect(rows(page)).toHaveCount(0);
    await expect(
      page.getByText('No pull requests match these filters.'),
    ).toBeVisible();
  });

  test('the box says it takes numbers, and has no axe violations', async ({
    page,
  }) => {
    await expect(box(page)).toHaveAttribute('placeholder', 'Title or #number');
    await box(page).fill('#2509');
    await expect(rows(page)).toHaveCount(1);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('filter the Bot PRs page by number (2514)', () => {
  test.beforeEach(async ({ page }) => {
    await open(page, '/bots.html');
    await expect(rows(page)).toHaveCount(3);
  });

  test('typing a bot pull request number lists only that one', async ({
    page,
  }) => {
    await box(page).fill('#3102');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText('right-pad');
  });

  test('a partial number matches numbers that start with it', async ({
    page,
  }) => {
    await box(page).fill('310');
    await expect(rows(page)).toHaveCount(3);
    await box(page).fill('3101');
    await expect(rows(page)).toHaveCount(1);
  });

  test('a number that matches nothing shows the empty state', async ({
    page,
  }) => {
    await box(page).fill('#2509');
    await expect(rows(page)).toHaveCount(0);
    await expect(
      page.getByText('No pull requests match these filters.'),
    ).toBeVisible();
  });
});
