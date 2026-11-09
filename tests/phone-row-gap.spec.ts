import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// #3264: on a phone the waiting chip's reserved slot (#1229) sat between the
// meta line and the status pill, so every Bots and Releases row read as having
// about 90px of blank space above the pill. The slot is still reserved, but
// below the pill. The gap to measure is meta line to pill.
const MAX_GAP = 16;

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

const PAGES = [
  {
    path: '/bots.html',
    pr: makePR(20, {
      title: 'Bump package-20 from 1.0.0 to 1.0.1',
      author: 'dependabot',
      kind: 'dependency',
    }),
  },
  {
    path: '/releases.html',
    pr: makePR(30, {
      title: 'chore(main): release 0.30.0',
      author: 'release-please[bot]',
      kind: 'release',
    }),
  },
];

function mockDashboard(page: Page, pullRequests: unknown[]) {
  return page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        navCounts: navCountsFor(pullRequests, 0),
      }),
    }),
  );
}

test.describe('phone rows keep the pill close to the meta line (#3264)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await page.setViewportSize({ width: 390, height: 844 });
  });

  for (const { path, pr } of PAGES) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${path} (${scheme}): at most ${MAX_GAP}px from meta to pill, slot still reserved below`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await mockDashboard(page, [pr]);
        await page.goto(path);
        const row = page.locator('#pr-rows > .row').first();
        await expect(row).toBeVisible();

        const m = await row.evaluate((r) => {
          const box = (s: string) =>
            r.querySelector(s)?.getBoundingClientRect();
          const metaBottom = Math.max(
            ...['.author', '.created', '.updated'].map(
              (s) => box(s)?.bottom ?? 0,
            ),
          );
          return {
            gap: (box('.ci-slot')?.top ?? 0) - metaBottom,
            slotTop: box('.wait-slot')?.top ?? 0,
            slotHeight: box('.wait-slot')?.height ?? 0,
            pillBottom: box('.ci-slot')?.bottom ?? 0,
          };
        });
        expect(m.gap).toBeLessThanOrEqual(MAX_GAP);
        expect(m.slotHeight).toBeGreaterThanOrEqual(44);
        expect(m.slotTop).toBeGreaterThanOrEqual(m.pillBottom);
      });
    }
  }
});
