import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// While the dashboard read has failed, Insights' chart cards must not say
// "No open pull requests." or "No open issues.": that reads as a real zero.
// https://github.com/alrayyes/forge-dashboard/issues/3361

const isRead = (url: string) => new URL(url).pathname === '/api/v1/dashboard';

const EMPTY_OK = {
  readIntervalSeconds: 600,
  firstRefreshDone: true,
  forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
  repos: [{ forge: 'github', fullName: 'acme/web', hasWebhook: true }],
  pullRequests: [],
  issues: [],
};

async function serve(page: Page, failing: boolean) {
  const state = { failing };
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) => {
    if (!isRead(route.request().url())) return route.fallback();
    if (state.failing)
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"boom"}',
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_OK),
    });
  });
  return state;
}

const CARDS = ['CI status', 'Busiest repos', 'Pull request age', 'Issue age'];

for (const theme of ['light', 'dark']) {
  test(`Insights chart cards say Data unavailable on a failed read (${theme}, 390px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/insights.html');
    await setTheme(page, theme);
    const state = await serve(page, true);
    await page.goto('/insights.html');

    await expect(page.getByRole('alert')).toContainText('(500)');
    for (const name of CARDS) {
      const card = page
        .locator('.card')
        .filter({ has: page.getByRole('heading', { name, exact: true }) });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText('Data unavailable');
    }
    await expect(page.locator('body')).not.toContainText(
      'No open pull requests.',
    );
    await expect(page.locator('body')).not.toContainText('No open issues.');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // Retry that succeeds with truly nothing open shows the real empty text.
    state.failing = false;
    await page
      .getByRole('alert')
      .getByRole('button', { name: 'Retry' })
      .click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Data unavailable');
    await expect(page.locator('#ci-status-empty')).toHaveText(
      'No open pull requests.',
    );
    await expect(page.locator('#issue-age-empty')).toHaveText(
      'No open issues.',
    );
  });
}
