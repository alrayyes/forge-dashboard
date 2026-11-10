import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3325: the Webhooks pager's Next and Previous buttons go `disabled` at the
// ends of the list, and a disabled element drops keyboard focus to BODY. At
// either end focus lands on the nearest button that remains, and a page
// number keeps focus. Focus is sampled after every press.

const repos = Array.from({ length: 60 }, (_, i) => ({
  forge: 'github',
  fullName: `alrayyes/repo-${String(i).padStart(2, '0')}`,
  hasWebhook: true,
}));

async function open(page: Page) {
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
        repos,
      }),
    }),
  );
  await page.goto('/webhooks.html');
  await expect(
    page.locator('#webhooks-pagination-pages .pagination-page.active'),
  ).toHaveText('1');
}

const pager = (page: Page) => page.locator('#webhooks-pagination-pages');
const nav = (page: Page, name: string) =>
  pager(page).locator('.pagination-nav').filter({ hasText: name });
const active = (page: Page) => pager(page).locator('.pagination-page.active');

const focus = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? '',
      text: (a?.textContent ?? '').trim(),
      inPager: a?.closest('#webhooks-pagination') != null,
    };
  });

test.describe('Webhooks pager focus (#3325)', () => {
  test('Next to the last page never drops to BODY and ends on Previous', async ({
    page,
  }) => {
    await open(page);
    await nav(page, 'Next').focus();
    await page.keyboard.press('Enter');
    await expect(active(page)).toHaveText('2');
    expect(await focus(page)).toMatchObject({ tag: 'BUTTON', text: 'Next' });
    await page.keyboard.press('Enter');
    await expect(active(page)).toHaveText('3');
    const f = await focus(page);
    expect(f.tag).not.toBe('BODY');
    expect(f).toMatchObject({ tag: 'BUTTON', text: 'Previous', inPager: true });
  });

  test('Previous on page 2 lands on Next, not BODY', async ({ page }) => {
    await open(page);
    await nav(page, 'Next').focus();
    await page.keyboard.press('Enter');
    await expect(active(page)).toHaveText('2');
    await nav(page, 'Previous').focus();
    await page.keyboard.press('Enter');
    await expect(active(page)).toHaveText('1');
    const f = await focus(page);
    expect(f.tag).not.toBe('BODY');
    expect(f).toMatchObject({ tag: 'BUTTON', text: 'Next', inPager: true });
  });

  test('a page number keeps focus on that page number', async ({ page }) => {
    await open(page);
    await pager(page)
      .locator('.pagination-page')
      .filter({ hasText: /^2$/ })
      .focus();
    await page.keyboard.press('Enter');
    await expect(active(page)).toHaveText('2');
    expect(await focus(page)).toMatchObject({ tag: 'BUTTON', text: '2' });
  });
});
