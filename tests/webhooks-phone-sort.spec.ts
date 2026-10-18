import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// On a phone the Webhooks table turns into cards and its header is clipped to
// 1px. The sort buttons in it must not be tab stops there, and a visible
// "Sort by" select takes over. The select and the header buttons share one
// saved sort.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `webhooks-sort-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Sort Test User');
}

const REPOS = [
  { forge: 'github', fullName: 'alrayyes/bravo', hasWebhook: true },
  { forge: 'forgejo', fullName: 'alrayyes/charlie', hasWebhook: false },
  { forge: 'github', fullName: 'alrayyes/alpha', hasWebhook: false },
];

function mockDashboard(page: Page) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [],
        pullRequests: [],
        issues: [],
        repos: REPOS.map((r) => ({ canManageWebhooks: true, ...r })),
      }),
    }),
  );
}

const names = (page: Page) =>
  page.locator('#webhooks-rows tr td[data-label="Repo"]').allInnerTexts();
const trim = (list: string[]) =>
  list.map((t) => t.replace(/^Repo\s*/, '').trim());

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await mockDashboard(page);
  await page.goto('/webhooks.html');
  await expect(page.locator('#webhooks-table')).toBeVisible();
}

test.describe('webhooks sort on a phone', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('Tab never lands on a control that cannot be seen at 390px', async ({
    page,
  }) => {
    await open(page, 390);
    await page.locator('#webhooks-repo-filter').focus();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const hidden = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const clipped = r.width < 4 || r.height < 4;
        const inHeader = !!el.closest('thead');
        return clipped || inHeader ? (el.outerHTML || '').slice(0, 80) : null;
      });
      expect(hidden, `tab stop ${i + 1}`).toBeNull();
    }
  });

  test('the header buttons are tab stops again once the table is wide', async ({
    page,
  }) => {
    await open(page, 1280);
    await expect(page.locator('[data-sort-key="forge"]')).not.toHaveAttribute(
      'tabindex',
      '-1',
    );
    await page.locator('[data-sort-key="forge"]').focus();
    await expect(page.locator('[data-sort-key="forge"]')).toBeFocused();
  });

  test('Sort by is hidden on a wide screen and visible at 390 and 700px', async ({
    page,
  }) => {
    await open(page, 1280);
    await expect(page.locator('#webhooks-sort-select')).toBeHidden();
    for (const width of [390, 700]) {
      await page.setViewportSize({ width, height: 844 });
      const select = page.locator('#webhooks-sort-select');
      await expect(select).toBeVisible();
      const box = await select.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('the phone select sorts, survives a reload and shows in the wide header', async ({
    page,
  }) => {
    await open(page, 390);
    expect(trim(await names(page))).toEqual([
      'alrayyes/alpha',
      'alrayyes/bravo',
      'alrayyes/charlie',
    ]);
    const select = page.locator('#webhooks-sort-select');
    await select.selectOption('fullName:desc');
    expect(trim(await names(page))).toEqual([
      'alrayyes/charlie',
      'alrayyes/bravo',
      'alrayyes/alpha',
    ]);

    await page.reload();
    await expect(page.locator('#webhooks-table')).toBeVisible();
    await expect(select).toHaveValue('fullName:desc');
    expect(trim(await names(page))[0]).toBe('alrayyes/charlie');

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(
      page.locator('th:has([data-sort-key="fullName"])'),
    ).toHaveAttribute('aria-sort', 'descending');
  });

  test('a header click on a wide screen moves the phone select', async ({
    page,
  }) => {
    await open(page, 1280);
    await page.locator('[data-sort-key="hasWebhook"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#webhooks-sort-select')).toHaveValue(
      'hasWebhook:asc',
    );
  });

  test('the select works from the keyboard', async ({ page }) => {
    await open(page, 390);
    const select = page.locator('#webhooks-sort-select');
    await select.focus();
    await expect(select).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(select).not.toHaveValue('fullName:asc');
    const value = await select.inputValue();
    const [key, dir] = value.split(':');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(
      page.locator(`th:has([data-sort-key="${key}"])`),
    ).toHaveAttribute('aria-sort', dir === 'desc' ? 'descending' : 'ascending');
  });

  test('Clear filters puts the select back to its default', async ({
    page,
  }) => {
    await open(page, 390);
    const select = page.locator('#webhooks-sort-select');
    await select.selectOption('forge:desc');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(select).toHaveValue('fullName:asc');
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [390, 700]) {
      test(`no axe-core violations at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await open(page, width);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
