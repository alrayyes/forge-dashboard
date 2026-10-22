import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A repo whose fetch keeps failing says so on its row in the repo list, with
// the time it began, so a long outage is not silent.

function mockDashboard(page: Page, repos: Record<string, unknown>[]) {
  void page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  return page.route('**/api/dashboard*', (route: Route) =>
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
}

const HOURS_AGO = (n: number) =>
  new Date(Date.now() - n * 3_600_000).toISOString();

test.describe('failing repo badge', () => {
  test('a repo with failingSince shows a badge saying since when', async ({
    page,
  }) => {
    await mockDashboard(page, [
      {
        forge: 'github',
        fullName: 'alrayyes/broken',
        hasWebhook: true,
        failingSince: HOURS_AGO(3),
      },
      { forge: 'github', fullName: 'alrayyes/fine', hasWebhook: true },
    ]);
    await page.goto('/webhooks.html');

    const broken = page.locator('tr', { hasText: 'alrayyes/broken' });
    await expect(broken.locator('.failing-badge')).toContainText(
      'Failing since',
    );
    await expect(
      page
        .locator('tr', { hasText: 'alrayyes/fine' })
        .locator('.failing-badge'),
    ).toHaveCount(0);
  });

  test('axe finds nothing with the badge showing', async ({ page }) => {
    await mockDashboard(page, [
      {
        forge: 'github',
        fullName: 'alrayyes/broken',
        hasWebhook: true,
        failingSince: HOURS_AGO(3),
      },
    ]);
    await page.goto('/webhooks.html');
    await expect(page.locator('.failing-badge')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
