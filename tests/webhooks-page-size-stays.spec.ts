import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3462: the Webhooks pager sat inside `totalPages > 1`, so picking a size that
// fits everything destroyed the Per page select and focus fell to BODY. Once
// a size is chosen the select stays; the page buttons come and go.

const repos = Array.from({ length: 60 }, (_, i) => ({
  forge: 'github',
  fullName: `alrayyes/repo-${String(i).padStart(2, '0')}`,
  hasWebhook: true,
}));

async function mock(page: Page, count: number) {
  await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos: repos.slice(0, count),
      }),
    }),
  );
}

async function open(page: Page) {
  await mock(page, 60);
  await page.goto('/webhooks.html');
  await expect(
    page.locator('#webhooks-pagination-pages .pagination-page.active'),
  ).toHaveText('1');
}

const select = (page: Page) => page.locator('#webhooks-page-size');
const pages = (page: Page) => page.locator('#webhooks-pagination-pages');

async function pick(page: Page, size: string) {
  await select(page).focus();
  await select(page).selectOption(size);
}

const focusedId = (page: Page) =>
  page.evaluate(() => document.activeElement?.id ?? '');

test.describe('Webhooks Per page select stays (#3462)', () => {
  test('stays visible, focused and valued on one page, buttons return on a smaller size', async ({
    page,
  }) => {
    await open(page);
    await pick(page, '100');
    await expect(select(page)).toBeVisible();
    await expect(select(page)).toHaveValue('100');
    await expect(pages(page)).toBeHidden();
    expect(await focusedId(page)).toBe('webhooks-page-size');

    await pick(page, '10');
    await expect(pages(page)).toBeVisible();
    await expect(select(page)).toHaveValue('10');
    expect(await focusedId(page)).toBe('webhooks-page-size');
  });

  test('no pager shows when everything fits and no size was chosen', async ({
    page,
  }) => {
    await mock(page, 5);
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-page-size')).toHaveCount(0);
    await expect(page.locator('#webhooks-pagination')).toHaveCount(0);
  });

  test(`single page with the select passes axe in light and dark`, async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(`${scheme}`, async () => {
        await page.emulateMedia({ colorScheme: scheme });

        await open(page);

        await pick(page, '100');

        await expect(select(page)).toBeVisible();

        const results = await new AxeBuilder({ page })
          .include('#webhooks-pagination')
          .analyze();

        expect(results.violations).toEqual([]);
      });
    }
  });

  test('select is 44px tall at 390 and nothing scrolls sideways at 320', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    await pick(page, '100');
    await expect(select(page)).toBeVisible();
    const box = await select(page).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.setViewportSize({ width: 320, height: 800 });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
