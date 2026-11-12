import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Insights and Webhooks used to show nothing when the dashboard read failed,
// so an empty page read as "0 repositories tracked" or "no webhooks". They now
// show a role="alert" message with a Retry that re-runs the layout's read.
// https://github.com/alrayyes/forge-dashboard/issues/3212

const isRead = (url: string) => new URL(url).pathname === '/api/v1/dashboard';

const GOOD = {
  readIntervalSeconds: 600,
  firstRefreshDone: true,
  forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
  repos: [
    { forge: 'github', fullName: 'acme/web', hasWebhook: true },
    { forge: 'github', fullName: 'acme/api', hasWebhook: false },
  ],
  pullRequests: [],
  issues: [],
};

type Mode = 'http500' | 'abort' | 'ok';

async function serve(page: Page, mode: Mode) {
  const state = { mode, reads: 0 };
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

const PAGES = [
  {
    name: 'Insights',
    url: '/insights.html',
    data: '#insights-tracked',
    shown: '2 repositories tracked',
    falseZero: '0 repositories tracked',
  },
  {
    name: 'Webhooks',
    url: '/webhooks.html',
    data: '#webhooks-table',
    shown: 'acme/web',
    falseZero: 'Nothing tracked yet',
  },
];

for (const p of PAGES) {
  test.describe(`${p.name} when the dashboard read fails`, () => {
    test('an HTTP 500 shows an alert, no false zero, and Retry recovers', async ({
      page,
    }) => {
      const state = await serve(page, 'http500');
      await page.goto(p.url);

      const alert = page.getByRole('alert');
      await expect(alert).toContainText(
        'The backend answered with an error (500)',
      );
      await expect(alert).not.toContainText('Could not reach');
      await expect(page.locator('body')).not.toContainText(p.falseZero);

      state.mode = 'ok';
      const before = state.reads;
      await alert.getByRole('button', { name: 'Retry' }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator(p.data)).toContainText(p.shown);
      expect(state.reads).toBeGreaterThan(before);
    });

    test('a network error shows the could-not-reach message, and Retry recovers', async ({
      page,
    }) => {
      const state = await serve(page, 'abort');
      await page.goto(p.url);

      const alert = page.getByRole('alert');
      await expect(alert).toContainText('Could not reach the backend');
      await expect(alert).not.toContainText('answered with an error');
      await expect(page.locator('body')).not.toContainText(p.falseZero);

      state.mode = 'ok';
      await alert.getByRole('button', { name: 'Retry' }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator(p.data)).toContainText(p.shown);
    });

    test('a successful read shows no alert', async ({ page }) => {
      await serve(page, 'ok');
      await page.goto(p.url);
      await expect(page.locator(p.data)).toContainText(p.shown);
      await expect(page.getByRole('alert')).toHaveCount(0);
    });

    test('Retry has a visible focus outline and a 44px target on a phone', async ({
      page,
    }) => {
      await serve(page, 'http500');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(p.url);

      const retry = page.getByRole('alert').getByRole('button', {
        name: 'Retry',
      });
      await expect(retry).toBeVisible();
      const box = await retry.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);

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
}
