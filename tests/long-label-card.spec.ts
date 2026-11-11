import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3396
//
// A label name has no length limit. At phone width the chip kept
// white-space: nowrap, so a 77-character name ran out of the card and was
// clipped. The wrapping rule used to apply only between 761px and 1103px.

const LONG =
  'kind/a-very-long-label-name-that-keeps-going-and-going-for-a-full-77-chars';
const NOW = new Date().toISOString();

const PR = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 1,
  title: 'Pull request 1',
  url: 'https://example.com/1',
  author: 'ryankes',
  draft: false,
  ci: 'success',
  labels: [{ name: LONG, color: 'cccccc' }],
  createdAt: NOW,
  updatedAt: NOW,
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
};
const ISSUE = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 2,
  title: 'Issue 2',
  url: 'https://example.com/issues/2',
  author: 'ryankes',
  labels: [{ name: LONG, color: 'cccccc' }],
  createdAt: NOW,
  updatedAt: NOW,
};

async function mock(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [PR],
        issues: [ISSUE],
      }),
    }),
  );
}

test.describe('a long label name stays inside its card (#3396)', () => {
  for (const [name, path, rows] of [
    ['Pull requests', '/pull-requests.html', '#pr-rows'],
    ['Issues', '/issues.html', '#issue-rows'],
  ] as const) {
    for (const [width, scheme] of [
      [320, 'light'],
      [390, 'light'],
      [320, 'dark'],
    ] as const) {
      test(`${name}: chip fits the card at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await mock(page);
        await page.goto(path);
        const row = page.locator(`${rows} > .row`).first();
        const chip = row.locator('.label-chip');
        await expect(chip).toHaveCount(1);
        const r = await row.boundingBox();
        const c = await chip.boundingBox();
        expect(r && c).toBeTruthy();
        if (!r || !c) return;
        expect(c.x + c.width).toBeLessThanOrEqual(r.x + r.width);
        expect(c.x).toBeGreaterThanOrEqual(r.x);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
          ),
        ).toBe(false);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
