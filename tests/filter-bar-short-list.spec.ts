import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// #3670: nothing on a page offers to search or sort a single item. With one
// row or none, the filter bar, the phone Filters button and the sort control
// are not drawn. The count is the list before filters.
// https://github.com/alrayyes/forge-dashboard/issues/3670

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: number % 2 ? 'claude' : 'ryan',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    allowedActions: [{ action: 'merge' }, { action: 'close' }],
    ...overrides,
  };
}

function makeIssue(number: number) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: number % 2 ? 'claude' : 'ryan',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
  };
}

async function serve(page: Page, pullRequests: unknown[], issues: unknown[]) {
  const answer = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues,
        openIssueCount: issues.length,
        navCounts: navCountsFor(pullRequests, issues.length),
      }),
    });
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', answer);
  await page.route('**/api/v1/dashboard/refresh*', answer);
}

const PAGES = [
  {
    path: '/pull-requests.html',
    rows: '#pr-rows .row',
    make: (n: number) => ({ pr: makePR(n), issue: null }),
  },
  {
    path: '/releases.html',
    rows: '#pr-rows .row',
    make: (n: number) => ({ pr: makePR(n, { kind: 'release' }), issue: null }),
  },
  {
    path: '/bots.html',
    rows: '#pr-rows .row',
    make: (n: number) => ({
      pr: makePR(n, { kind: 'dependency' }),
      issue: null,
    }),
  },
  {
    path: '/issues.html',
    rows: '#issue-rows .row',
    make: (n: number) => ({ pr: null, issue: makeIssue(n) }),
  },
] as const;

function data(p: (typeof PAGES)[number], count: number) {
  const made = Array.from({ length: count }, (_, i) => p.make(i + 1));
  return {
    prs: made.flatMap((m) => (m.pr ? [m.pr] : [])),
    issues: made.flatMap((m) => (m.issue ? [m.issue] : [])),
  };
}

const VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

for (const p of PAGES) {
  test.describe(`${p.path} short lists (#3670)`, () => {
    for (const viewport of VIEWPORTS) {
      test(`one row shows no filter bar, Filters button or sort at ${viewport.width}px`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const { prs, issues } = data(p, 1);
        await serve(page, prs, issues);
        await page.goto(p.path);

        await expect(page.locator(p.rows)).toHaveCount(1);
        await expect(page.locator('.filter-bar')).toBeHidden();
        await expect(page.locator('#filters-button')).toBeHidden();
        await expect(page.locator('#pr-sort-select')).toBeHidden();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });

      test(`two rows show the filter bar and sort at ${viewport.width}px`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const { prs, issues } = data(p, 2);
        await serve(page, prs, issues);
        await page.goto(p.path);

        await expect(page.locator(p.rows)).toHaveCount(2);
        await expect(page.locator('.filter-bar')).toBeVisible();
        if (viewport.width >= 760)
          await expect(page.locator('#pr-sort-select')).toBeVisible();
        else await expect(page.locator('#filters-button')).toBeVisible();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }

    test('an empty list shows the empty state and no filter bar', async ({
      page,
    }) => {
      await serve(page, [], []);
      await page.goto(p.path);

      await expect(page.locator(p.rows)).toHaveCount(0);
      await expect(page.locator('.filter-bar')).toBeHidden();
    });
  });
}

test('a filter that narrows a longer list to one row keeps the bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serve(page, [makePR(1), makePR(2), makePR(3)], []);
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows .row')).toHaveCount(3);

  await page
    .locator('.filter-bar input[data-col="title"]')
    .fill('Pull request 2');
  await expect(page.locator('#pr-rows .row')).toHaveCount(1);
  await expect(page.locator('.filter-bar')).toBeVisible();
  await expect(page.locator('#pr-sort-select')).toBeVisible();

  await page.locator('#clear-filters-button').click();
  await expect(page.locator('#pr-rows .row')).toHaveCount(3);
});
