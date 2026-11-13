import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// The Title search is the control people type into, so it is the widest in
// the filter bar. The Updated select holds a few short choices and stays
// narrow. Before, every control in the bar shared one flex basis and the
// Updated select grew as wide as the search box.
// https://github.com/alrayyes/forge-dashboard/issues/2937

// Two rows each, since a bar over one row or none is not drawn (#3670).
const row = (n: number) => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: n,
  title: `Item ${n}`,
  url: `https://example.com/${n}`,
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date(Date.now() - n * 1000).toISOString(),
  mergeStatus: 'mergeable',
});
const ROWS = [row(1), row(2)];

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
        pullRequests: ROWS,
        issues: ROWS,
        repos: [],
        hiddenDrafts: 0,
        navCounts: navCountsFor(ROWS, ROWS.length),
      }),
    }),
  );
  await page.goto(path);
}

async function widths(page: Page) {
  const title = page.locator('.filter-bar #title-filter');
  const updated = page.locator('.filter-bar select[data-col="updated"]');
  await expect(title).toBeVisible();
  return {
    title: (await title.boundingBox())?.width ?? 0,
    updated: (await updated.boundingBox())?.width ?? 0,
  };
}

test.describe('filter bar widths (2937)', () => {
  for (const [name, path] of [
    ['issues', '/issues.html'],
    ['pull requests', '/pull-requests.html'],
  ] as const) {
    for (const width of [1280, 900]) {
      test(`${name}: the title search is wider than Updated at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await open(page, path);
        const w = await widths(page);
        expect(w.title).toBeGreaterThan(w.updated);
      });
    }
  }
});
