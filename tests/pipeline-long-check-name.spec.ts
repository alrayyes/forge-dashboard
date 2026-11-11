import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { factsOf } from './check-facts';
import { serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const LONG =
  'build (ubuntu-latest, node 22, with-a-very-long-matrix-axis-name=' +
  'x'.repeat(46) +
  ')';
const NAMES = [
  'lint',
  LONG,
  ...Array.from({ length: 34 }, (_, i) => `job-${i} ${LONG}`),
];

async function open(page: Page) {
  const now = new Date().toISOString();
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/forge-dashboard',
            number: 42,
            title: 'Add structured logging',
            url: 'https://example.com/42',
            author: 'ryankes',
            draft: false,
            ci: 'failure',
            labels: [],
            createdAt: now,
            updatedAt: now,
            mergeStatus: 'mergeable',
            behind: false,
          },
        ],
        issues: [],
      }),
    }),
  );
  await serveChecks(page, () =>
    NAMES.map((name) => ({
      name,
      ...factsOf('failure'),
      url: '',
      required: true,
    })),
  );
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
  await expect(dialog.locator('.pipeline-check')).toHaveCount(NAMES.length);
  return dialog;
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [320, 820]) {
    test(`a long check name stays readable at ${width}px, ${scheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      const dialog = await open(page);
      const name = dialog
        .locator('.pipeline-check-name', { hasText: LONG })
        .first();
      await expect(name).toBeVisible();
      const cut = await name.evaluate(
        (el) =>
          el.scrollWidth > el.clientWidth + 1 ||
          el.scrollHeight > el.clientHeight + 1,
      );
      expect(cut, 'the name is cut off').toBe(false);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
