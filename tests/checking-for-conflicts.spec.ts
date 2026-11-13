import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A Forgejo pull request whose mergeable flag is false on a moved base may
// only be rechecking after a base push, so its row says "Checking for
// conflicts" in words and not "Conflicting". It must not change the row's
// height next to a confirmed conflict.

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'forgejo',
    repo: 'andthensome/homepage',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    kind: 'regular',
    ...overrides,
  };
}

const PRS = [
  makePR(1, { title: 'Base moved, check running', mergeStatus: 'checking' }),
  makePR(2, { title: 'Base moved, conflict', mergeStatus: 'conflicting' }),
];

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: [],
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

for (const theme of ['light', 'dark'] as const) {
  for (const width of [390, 820, 1280]) {
    test.describe(`${theme} at ${width}px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 900 });
        await open(page);
      });

      test('says Checking for conflicts in words, not Conflicting', async ({
        page,
      }) => {
        const checking = row(page, 'check running');
        await expect(checking.locator('.merge-pill')).toHaveText(
          'Checking for conflicts',
        );
        await expect(checking).not.toContainText('Conflicting');
        await expect(row(page, 'Base moved, conflict')).toContainText(
          'Conflicting',
        );
      });

      test('draws the pill as tall as the conflict pill, on one line', async ({
        page,
      }) => {
        // The conflict row no longer draws a locked Merge (#3770), so the rows
        // differ in height; what matters is that the longer words don't wrap.
        const a = await row(page, 'check running')
          .locator('.merge-pill')
          .boundingBox();
        const b = await row(page, 'Base moved, conflict')
          .locator('.merge-pill')
          .boundingBox();
        expect(
          Math.abs((a?.height ?? 0) - (b?.height ?? 0)),
        ).toBeLessThanOrEqual(1);
      });

      test('has no axe violations', async ({ page }) => {
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    });
  }
}
