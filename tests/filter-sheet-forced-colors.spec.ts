import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// In forced colors the Filters sheet controls keep a dropdown cue: the native
// arrow on the selects, a border-drawn one on the pick triggers, as in the bar.
// https://github.com/alrayyes/forge-dashboard/issues/3821

const item = (number: number, repo: string) => ({
  forge: 'github',
  repo,
  number,
  title: `Item ${number}`,
  url: `https://example.com/${number}`,
  author: number === 1 ? 'ryan' : 'sam',
  draft: false,
  ci: 'success',
  labels: [{ name: number === 1 ? 'docs' : 'bug', color: 'd73a4a' }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'mergeable',
});

async function openSheet(page: Page, path: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: [item(1, 'alrayyes/app'), item(2, 'alrayyes/api')],
        issues: [item(1, 'alrayyes/app'), item(2, 'alrayyes/api')],
        openIssueCount: 2,
        navCounts: navCountsFor([], 0),
        firstRefreshDone: true,
      }),
    }),
  );
  await page.goto(path);
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.locator('dialog#filter-sheet')).toBeVisible();
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [name, path] of [
    ['issues', '/issues.html'],
    ['pull requests', '/pull-requests.html'],
  ] as const) {
    test(`${name}: sheet controls show a dropdown arrow in forced colors, ${scheme} (3821)`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
      await openSheet(page, path);
      await expect(async () => {
        const selects = page.locator('dialog#filter-sheet select:visible');
        expect(await selects.count()).toBeGreaterThan(0);
        for (const el of await selects.all()) {
          const shown = await el.evaluate((s) => ({
            id: s.id,
            appearance: getComputedStyle(s).appearance,
            chevron: getComputedStyle(s).backgroundImage,
            clipped: s.scrollWidth > s.clientWidth,
          }));
          const hasArrow =
            shown.appearance !== 'none' ||
            !/^none(, none)*$/.test(shown.chevron);
          expect(hasArrow, JSON.stringify(shown)).toBe(true);
          expect(shown.clipped, JSON.stringify(shown)).toBe(false);
        }
        const triggers = page.locator(
          'dialog#filter-sheet .label-filter-button:visible',
        );
        expect(await triggers.count()).toBeGreaterThan(0);
        for (const el of await triggers.all()) {
          const arrow = await el.evaluate((b) => {
            const cs = getComputedStyle(b, '::after');
            return {
              content: cs.content,
              bottom: Number.parseFloat(cs.borderBottomWidth),
              right: Number.parseFloat(cs.borderRightWidth),
              color: cs.borderBottomColor,
              text: getComputedStyle(b).color,
            };
          });
          expect(arrow.content).not.toMatch(/^(none|normal)$/);
          expect(arrow.bottom).toBeGreaterThan(0);
          expect(arrow.right).toBeGreaterThan(0);
          expect(arrow.color).toBe(arrow.text);
        }
      }).toPass();

      const results = await new AxeBuilder({ page })
        .include('dialog#filter-sheet')
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
