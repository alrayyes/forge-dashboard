import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// On a phone the one control a row draws sits in its own action row: after a
// hairline divider, full width and 44px tall, so the thumb finds it. The
// 44px is WCAG 2.5.5 (AAA); 2.5.8 (AA) asks 24px.
// https://github.com/alrayyes/forge-dashboard/issues/898

test.use({ storageState: SHARED_STORAGE_STATE_PATH });

function pr(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number: 7,
    title: 'A longer pull request title that wraps onto a second line',
    url: 'https://example.com/pull/7',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    ...overrides,
  };
}

async function open(page: Page, pullRequest: unknown) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pullRequest],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  const row = page.locator('#pr-rows > .row').first();
  await expect(row).toBeVisible();
  return row;
}

const cases = [
  { name: 'Merge', overrides: {} },
  {
    name: 'a locked Merge',
    overrides: { ci: 'failure', mergeStatus: 'blocked' },
  },
];

for (const width of [360, 390]) {
  for (const { name, overrides } of cases) {
    test(`${width}px: ${name} is one full-width 44px button after a divider`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const row = await open(page, pr(overrides));
      const bar = row.locator('.row-action-bar');
      await expect(bar).toBeVisible();
      expect(
        await bar.evaluate((el) => getComputedStyle(el).borderTopWidth),
      ).toBe('1px');

      const btn = bar.getByRole('button', { name: 'Merge' });
      const box = await btn.boundingBox();
      const barBox = await bar.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual((barBox?.width ?? 0) - 1);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
    });
  }
}

test('a locked Merge stays in the action row, greyed, with its reason', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const row = await open(page, pr({ ci: 'failure', mergeStatus: 'blocked' }));
  const bar = row.locator('.row-action-bar');
  await expect(bar.getByRole('button', { name: 'Merge' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe finds nothing on the phone card in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 900 });
    await open(page, pr());
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('on a desktop the button keeps its small size beside the status', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const row = await open(page, pr());
  const box = await row.getByRole('button', { name: 'Merge' }).boundingBox();
  expect(box?.height).toBeLessThan(44);
  expect(box?.width).toBeLessThan(200);
  expect(
    await row
      .locator('.row-action-bar')
      .evaluate((el) => getComputedStyle(el).display),
  ).toBe('contents');
});
