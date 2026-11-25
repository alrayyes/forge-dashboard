import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A Forgejo pull request whose mergeable flag is false on a moved base may
// only be rechecking after a base push, so its row says so in words and not
// "Conflicting". The waiting chip already says "Checking for conflicts", so
// the "Checking for conflicts" pill stays out: one place says it (#4531).

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
        forges: [forgeHealth('forgejo')],
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

      test('says the check is running once, in words, not Conflicting', async ({
        page,
      }) => {
        const checking = row(page, 'check running');
        await expect(
          checking.getByText('Checking for conflicts'),
        ).toBeVisible();
        await expect(checking.locator('.merge-pill')).toHaveCount(0);
        // The chip says it once, so the pill must not say it again.
        await expect(checking.getByText('Checking for conflicts')).toHaveCount(
          1,
        );
        await expect(checking).not.toContainText('Conflicting');
        // A confirmed conflict is the status block's words, not a pill.
        await expect(row(page, 'Base moved, conflict')).toContainText(
          'Merge conflict',
        );
      });
    });
  }
}

// One test loops both themes and every width: the page is the same code in
// each, so six separate tests only paid for six fixtures and six loads.
test('has no axe violations in light and dark at 390, 820 and 1280px', async ({
  page,
}) => {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [390, 820, 1280]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations, `${theme} at ${width}px`).toEqual([]);
    }
  }
});
