import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The error banner on the list pages says what went wrong (an HTTP error is
// not "could not reach") and carries a Retry button that re-reads the board.
// https://github.com/alrayyes/forge-dashboard/issues/3211

const isRead = (url: string) => new URL(url).pathname === '/api/v1/dashboard';

const GOOD = {
  readIntervalSeconds: 600,
  firstRefreshDone: true,
  forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
  repos: [{ forge: 'github', fullName: 'acme/web', hasWebhook: true }],
  pullRequests: [],
  issues: [],
};

type Mode = 'http500' | 'abort' | 'ok';

async function serve(page: Page) {
  const state = { mode: 'http500' as Mode, reads: 0 };
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) => {
    if (!isRead(route.request().url())) return route.fallback();
    state.reads++;
    if (state.mode === 'abort') return route.abort();
    if (state.mode === 'http500')
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"boom"}',
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(GOOD),
    });
  });
  return state;
}

test.describe('Dashboard error banner', () => {
  test('an HTTP 500 says the backend answered with an error, and Retry recovers', async ({
    page,
  }) => {
    const state = await serve(page);
    await page.goto('/pull-requests.html');

    const banner = page.locator('#error-banner');
    await expect(banner).toContainText(
      'The backend answered with an error (500)',
    );
    await expect(banner).not.toContainText('Could not reach');
    await expect(banner).toHaveAttribute('role', 'alert');

    state.mode = 'ok';
    const before = state.reads;
    await banner.getByRole('button', { name: 'Retry' }).click();
    await expect(banner).toHaveCount(0);
    expect(state.reads).toBeGreaterThan(before);
  });

  test('a network failure still says the backend could not be reached, with Retry', async ({
    page,
  }) => {
    const state = await serve(page);
    state.mode = 'abort';
    await page.goto('/pull-requests.html');

    const banner = page.locator('#error-banner');
    await expect(banner).toContainText('Could not reach the backend');
    await expect(banner).not.toContainText('answered with an error');

    state.mode = 'ok';
    await banner.getByRole('button', { name: 'Retry' }).click();
    await expect(banner).toHaveCount(0);
  });

  test('Retry has a visible focus outline and a 44px target on a phone', async ({
    page,
  }) => {
    await serve(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/pull-requests.html');

    const retry = page
      .locator('#error-banner')
      .getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    const box = await retry.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);

    await page.keyboard.press('Tab');
    await retry.focus();
    await expect(retry).toBeFocused();
    await expect(retry).not.toHaveCSS('outline-style', 'none');
    await expect
      .poll(() =>
        retry.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth)),
      )
      .toBeGreaterThanOrEqual(2);
  });
});
