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

async function serve(
  page: Page,
  pullRequests: unknown[],
  issues: unknown[],
  live?: () => { prs: unknown[]; issues: unknown[] },
) {
  const answer = (route: Route) => {
    const now = live?.() ?? { prs: pullRequests, issues };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: now.prs,
        issues: now.issues,
        openIssueCount: now.issues.length,
        navCounts: navCountsFor(now.prs, now.issues.length),
      }),
    });
  };
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', answer);
  await page.route('**/api/v1/dashboard/refresh*', answer);
}

const PAGES = [
  {
    path: '/pull-requests.html',
    emptyText: /No open pull requests/,
    rows: '#pr-rows .row',
    make: (n: number) => ({ pr: makePR(n), issue: null }),
  },
  {
    path: '/releases.html',
    emptyText: /No release pull requests are open/,
    rows: '#pr-rows .row',
    make: (n: number) => ({ pr: makePR(n, { kind: 'release' }), issue: null }),
  },
  {
    path: '/bots.html',
    emptyText: /No bot pull requests are open/,
    rows: '#pr-rows .row',
    make: (n: number) => ({
      pr: makePR(n, { kind: 'dependency' }),
      issue: null,
    }),
  },
  {
    path: '/issues.html',
    emptyText: /No open issues/,
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
      await expect(page.getByText(p.emptyText)).toBeVisible();
    });

    // The list changes under an open page: the bar follows the count without
    // a reload, both ways across the threshold.
    test('the bar follows a live snapshot across one row and two', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      let count = 2;
      await serve(page, [], [], () => data(p, count));
      await page.goto(p.path);
      await expect(page.locator(p.rows)).toHaveCount(2);
      await expect(page.locator('.filter-bar')).toBeVisible();

      const refresh = () =>
        page
          .locator('#force-refresh-button')
          .evaluate((el) => (el as HTMLElement).click());

      count = 1;
      await refresh();
      await expect(page.locator(p.rows)).toHaveCount(1);
      await expect(page.locator('.filter-bar')).toBeHidden();

      count = 2;
      await refresh();
      await expect(page.locator(p.rows)).toHaveCount(2);
      await expect(page.locator('.filter-bar')).toBeVisible();

      count = 0;
      await refresh();
      await expect(page.locator(p.rows)).toHaveCount(0);
      await expect(page.locator('.filter-bar')).toBeHidden();
    });
  });
}

// A picked filter keeps the bar over a single row, because the bar is the
// only place to undo it. Each pick is made on a longer list; the list then
// shrinks to the one row that matches it.
const PICKS = [
  {
    name: 'a title search',
    pick: (page: Page) =>
      page
        .locator('.filter-bar input[data-col="title"]')
        .fill('Pull request 1'),
  },
  {
    name: 'the Failing pill',
    pick: (page: Page) =>
      page.locator('.quick-pills .quick-pill[data-pill="failing"]').click(),
  },
  {
    name: 'a forge pill',
    pick: (page: Page) =>
      page.locator('.quick-pills .quick-pill[data-pill="github"]').click(),
  },
];

for (const pick of PICKS) {
  test(`${pick.name} over a single row keeps the bar and Clear filters`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const all = [
      makePR(1, { ci: 'failure' }),
      makePR(2, { forge: 'forgejo' }),
      makePR(3, { ci: 'failure' }),
    ];
    let rows: unknown[] = all;
    await serve(page, [], [], () => ({ prs: rows, issues: [] }));
    await page.goto('/pull-requests.html');
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);

    await pick.pick(page);
    rows = [all[0]];
    await page
      .locator('#force-refresh-button')
      .evaluate((el) => (el as HTMLElement).click());

    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(page.locator('.filter-bar')).toBeVisible();
    await expect(page.locator('#pr-sort-select')).toBeVisible();
    await expect(page.locator('#clear-filters-button')).toBeEnabled();

    await page.locator('#clear-filters-button').click();
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await expect(page.locator('.filter-bar')).toBeHidden();
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

// A list that waited lands later (updates paused, #1427): the bar follows the
// list that lands, not the newest snapshot that arrived while it waited.
declare global {
  interface Window {
    __push: (data: unknown) => void;
  }
}

for (const p of PAGES) {
  test(`${p.path}: a held list brings the bar back when it lands with two rows (#3670)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      class StubEventSource {
        onmessage: ((e: { data: string }) => void) | null = null;
        constructor() {
          (window as unknown as { __es: StubEventSource }).__es = this;
        }
        close() {}
        addEventListener() {}
      }
      (window as unknown as { EventSource: unknown }).EventSource =
        StubEventSource;
      window.__push = (d) =>
        (window as unknown as { __es: StubEventSource }).__es.onmessage?.({
          data: JSON.stringify(d),
        });
    });
    const snap = (n: number) => {
      const { prs, issues } = data(p, n);
      return {
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: prs,
        issues,
        openIssueCount: issues.length,
        navCounts: navCountsFor(prs, issues.length),
      };
    };
    await page.route('**/api/v1/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snap(1)),
      }),
    );
    await page.goto(p.path);
    await expect(page.locator(p.rows)).toHaveCount(1);
    await expect(page.locator('.filter-bar')).toBeHidden();
    await page.waitForFunction(
      () =>
        (window as unknown as { __es?: { onmessage: unknown } }).__es
          ?.onmessage != null,
    );

    await page
      .getByRole('button', { name: /^(Pause|Resume) live updates$/ })
      .click();
    await page.evaluate((d) => window.__push(d), snap(2));
    await expect(page.locator('.live-control')).toContainText('Paused');
    await expect(page.locator(p.rows)).toHaveCount(1);
    await expect(page.locator('.filter-bar')).toBeHidden();

    await page
      .getByRole('button', { name: /^(Pause|Resume) live updates$/ })
      .click();
    await expect(page.locator(p.rows)).toHaveCount(2);
    await expect(page.locator('.filter-bar')).toBeVisible();
  });
}
