import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Forge pills in Settings, Repositories are never clipped, and the Forge
// row, the search field and the Sort select share one width.
// https://github.com/alrayyes/forge-dashboard/issues/4855

const repo = (forge: string, name: string) => ({
  forge,
  fullName: `alrayyes/${name}`,
  hasWebhook: true,
  canManageWebhooks: true,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
  rebaseBots: false,
});

async function open(page: Page, width: number, scheme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos: [repo('github', 'app'), repo('forgejo', 'wiki')],
      }),
    }),
  );
  await page.goto('/settings.html#repositories');
  await page.locator('.filter-bar .filter-pill').first().waitFor();
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [320, 390, 768, 1280]) {
    for (const zoom of [100, 175]) {
      test(`${width}px, ${zoom}% text, ${scheme}: pills fit the filter box`, async ({
        page,
      }) => {
        await open(page, width, scheme);
        if (zoom !== 100) {
          await page.addStyleTag({
            content: `html { font-size: ${zoom}% !important; }`,
          });
        }
        const bar = (await page.locator('.filter-bar').boundingBox())!;
        const pills = page.locator('.filter-bar .filter-pill');
        expect(await pills.count()).toBe(3);
        for (const pill of await pills.all()) {
          const box = (await pill.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(bar.x - 0.5);
          expect(box.x + box.width).toBeLessThanOrEqual(
            bar.x + bar.width + 0.5,
          );
          await pill.focus();
          await expect(pill).toBeFocused();
        }
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        ).toBe(true);
        // No ancestor up to the bar scrolls or clips the pills sideways.
        const clips = await page
          .locator('.filter-bar .filter-group')
          .evaluate((el) => {
            for (let n: Element | null = el; n; n = n.parentElement) {
              if (n.classList.contains('filter-bar')) return false;
              if (n.scrollWidth > n.clientWidth + 1) return true;
              if (getComputedStyle(n).overflowX !== 'visible') return true;
            }
            return false;
          });
        expect(clips).toBe(false);
      });
    }

    test(`${width}px, ${scheme}: three controls share one width, axe clean`, async ({
      page,
    }) => {
      await open(page, width, scheme);
      if (width <= 760) {
        const boxes = await Promise.all(
          [
            '.filter-bar .filter-group',
            '.filter-bar .search-field',
            '.filter-bar .repositories-sort',
          ].map(async (s) => (await page.locator(s).boundingBox())!),
        );
        const left = boxes[0].x;
        const right = boxes[0].x + boxes[0].width;
        for (const b of boxes) {
          expect(Math.abs(b.x - left)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(b.x + b.width - right)).toBeLessThanOrEqual(0.5);
        }
      }
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
