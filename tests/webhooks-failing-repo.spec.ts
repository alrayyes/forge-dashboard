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
    await expect(broken.locator('.failing-note')).toBeVisible();
    await expect(
      page
        .locator('tr', { hasText: 'alrayyes/fine' })
        .locator('.failing-badge'),
    ).toHaveCount(0);
  });

  test('a repo past the cutoff reads differently, as text', async ({
    page,
  }) => {
    await mockDashboard(page, [
      {
        forge: 'github',
        fullName: 'alrayyes/new',
        hasWebhook: true,
        failingSince: HOURS_AGO(1),
      },
      {
        forge: 'github',
        fullName: 'alrayyes/old',
        hasWebhook: true,
        failingSince: HOURS_AGO(30),
        failingForGood: true,
      },
    ]);
    await page.goto('/webhooks.html');

    const fresh = page.locator('tr', { hasText: 'alrayyes/new' });
    const old = page.locator('tr', { hasText: 'alrayyes/old' });
    await expect(fresh.locator('.failing-badge')).toContainText(
      'Failing since',
    );
    await expect(fresh.locator('.failing-badge')).not.toContainText(
      'Still failing',
    );
    await expect(old.locator('.failing-badge')).toContainText(
      'Still failing since',
    );
    await expect(old.locator('.failing-note')).toContainText('stopped waiting');
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      test(`axe and layout are clean in ${scheme} at ${width}px`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 800 });
        await mockDashboard(page, [
          {
            forge: 'github',
            fullName: 'alrayyes/broken',
            hasWebhook: true,
            failingSince: HOURS_AGO(3),
          },
          {
            forge: 'github',
            fullName: 'alrayyes/old-and-a-very-long-repository-name',
            hasWebhook: true,
            failingSince: HOURS_AGO(30),
            failingForGood: true,
          },
        ]);
        await page.goto('/webhooks.html');
        await expect(page.locator('.failing-badge')).toHaveCount(2);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        expect(overflow).toBe(false);
      });
    }
  }
});
