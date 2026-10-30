import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// On a wide screen a title takes the row's spare width and is cut only when
// the row has none left. Before, the title column shrank to fit its labels and
// pills, so a long title was cut with a wide empty gap before the Created
// column.
// https://github.com/alrayyes/forge-dashboard/issues/2801

const LONG =
  'fix(dashboard): settle box overrides only for rows a full refresh fetched and keep the rest';

const linked = {
  forge: 'github',
  repo: 'acme/app',
  number: 9,
  draft: false,
  pageUrl: '/pull-requests.html',
  ci: 'success',
  checks: { passed: 24, running: 0, waiting: 0, failed: 0 },
  awaitingWorkflowApproval: false,
};

const ISSUES = [
  {
    forge: 'github',
    repo: 'acme/app',
    number: 2796,
    title: LONG,
    url: 'https://example.com/acme/app/issues/2796',
    author: 'alrayyes',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    linkedPullRequests: [linked],
    createdAt: new Date(Date.now() - 36 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 36 * 60_000).toISOString(),
  },
];

const PULL_REQUESTS = [
  {
    forge: 'github',
    repo: 'acme/app',
    number: 2798,
    title: LONG,
    url: 'https://example.com/acme/app/pull/2798',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
  },
];

async function open(page: Page, path: string) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
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

// The title column's width, the cell after it, and whether the page scrolls.
async function titleGeometry(page: Page, board: string) {
  const row = page.locator(`#${board} > .row`).first();
  await expect(row).toBeVisible();
  return row.evaluate((r) => {
    const cell = r.querySelector('.title-cell') as HTMLElement;
    const after = r.querySelector('.author') as HTMLElement;
    const go = r.querySelector('.go') as HTMLElement;
    const status = r.querySelector('.status-cell') as HTMLElement | null;
    const box = cell.getBoundingClientRect();
    const tracks = getComputedStyle(r).gridTemplateColumns.split(' ');
    return {
      isIssueRow: r.classList.contains('issue-row'),
      goRight: go.getBoundingClientRect().right,
      viewport: document.documentElement.clientWidth,
      // The status track is the one right before the arrow's.
      statusTrack: Number.parseFloat(tracks[tracks.length - 2]),
      statusWidth: status ? status.getBoundingClientRect().width : 0,
      width: box.width,
      gapToAuthor: after.getBoundingClientRect().left - box.right,
      scrollsSideways:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    };
  });
}

test.describe('title width (2801)', () => {
  test('an issue title takes the status column the row does not use', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1970, height: 900 });
    await open(page, '/issues.html');
    const g = await titleGeometry(page, 'issue-rows');
    // 268px before, with a 280px empty track after the Updated column.
    expect(g.isIssueRow).toBe(true);
    expect(g.width).toBeGreaterThan(540);
    expect(g.gapToAuthor).toBeLessThanOrEqual(13);
    expect(g.scrollsSideways).toBe(false);
  });

  test('a pull request keeps its status column', async ({ page }) => {
    await page.setViewportSize({ width: 1970, height: 900 });
    await open(page, '/pull-requests.html');
    const g = await titleGeometry(page, 'pr-rows');
    expect(g.isIssueRow).toBe(false);
    // The status cell fills a real track after the Updated column, so the
    // title shares the row with it instead of taking its width.
    expect(g.statusTrack).toBeGreaterThan(0);
    expect(g.statusWidth).toBeCloseTo(g.statusTrack, 0);
    expect(g.scrollsSideways).toBe(false);
  });

  for (const [board, path] of [
    ['issue-rows', '/issues.html'],
    ['pr-rows', '/pull-requests.html'],
  ] as const) {
    test(`a phone keeps ${board} stacked without scrolling sideways`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await open(page, path);
      const g = await titleGeometry(page, board);
      expect(g.width).toBeGreaterThan(300);
      expect(g.scrollsSideways).toBe(false);
    });
  }

  test('a mid-width issue row keeps its title and arrow on screen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await open(page, '/issues.html');
    const g = await titleGeometry(page, 'issue-rows');
    expect(g.width).toBeGreaterThan(400);
    expect(g.goRight).toBeLessThanOrEqual(g.viewport);
    expect(g.scrollsSideways).toBe(false);
  });
});
