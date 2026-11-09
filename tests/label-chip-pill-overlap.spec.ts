import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3261
//
// At 820px the stacked label chips of a Releases or Bots row ran under the CI
// pill, and axe's target-size rule (WCAG 2.5.8) flagged the covered chips: an
// undersized target may not overlap another target.

const LABELS = [
  { name: 'autorelease: pending', color: 'ededed' },
  { name: 'dependencies: javascript-runtime', color: 'ededed' },
  { name: 'priority: needs-a-human-to-look-at-this', color: 'ededed' },
];

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
    labels: LABELS,
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
    name: 'Releases',
    path: '/releases.html',
    pr: makePR(1, {
      title: 'chore(main): release 1.2.0',
      author: 'release-please[bot]',
      kind: 'release',
    }),
  },
  {
    name: 'Bots',
    path: '/bots.html',
    pr: makePR(2, {
      title: 'Bump package-2 from 1.0.0 to 1.0.1',
      author: 'dependabot',
      kind: 'dependency',
    }),
  },
] as const;

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

test.describe('Label chips and the CI pill (#3261)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  });

  for (const { name, path, pr } of PAGES) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [390, 820, 1280]) {
        test(`${name}: chips stay clear of the pill, ${scheme}, ${width}px`, async ({
          page,
        }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await page.setViewportSize({ width, height: 900 });
          await mockDashboard(page, [pr]);
          await page.goto(path);
          const row = page.locator('#pr-rows > .row').first();
          await expect(row).toBeVisible();
          await expect(row.locator('.label-chip')).toHaveCount(3);

          const chips = await row.locator('.label-chip').evaluateAll((els) =>
            els.map((el) => {
              const r = el.getBoundingClientRect();
              return { l: r.left, t: r.top, r: r.right, b: r.bottom };
            }),
          );
          const pill = await row.locator('.ci-pill').first().boundingBox();
          expect(pill).not.toBeNull();
          if (!pill) return;
          for (const c of chips) {
            const apart =
              c.r <= pill.x ||
              c.l >= pill.x + pill.width ||
              c.b <= pill.y ||
              c.t >= pill.y + pill.height;
            expect(apart, `chip ${JSON.stringify(c)} vs pill`).toBe(true);
          }

          const results = await new AxeBuilder({ page })
            .withRules(['target-size'])
            .withTags(['wcag22aa'])
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    }
  }
});
