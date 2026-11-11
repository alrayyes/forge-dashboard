import AxeBuilder from '@axe-core/playwright';
import { expect, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3527: GitHub answering with a 5xx is not GitHub being unreachable. The
// banner says it answered, names the status code and still offers Retry.

const forge = {
  forge: 'github',
  reachable: false,
  repoCount: 1,
  errorKind: 'upstream_error',
  upstreamStatus: 504,
  error: 'GitHub returned 504 Gateway Timeout',
  staleSince: new Date(Date.now() - 5 * 60_000).toISOString(),
};

test.describe('an upstream error banner (#3527)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      /\/api\/v1\/dashboard(\/refresh|\/stream)?(\?.*)?$/,
      (route: Route) => {
        if (route.request().url().includes('/stream')) return route.abort();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [forge],
            pullRequests: [],
            issues: [],
          }),
        });
      },
    );
  });

  test('names the status code and does not say unreachable', async ({
    page,
  }) => {
    await page.goto('/pull-requests.html');

    const banner = page.locator('#unreachable-banner');
    await expect(banner).toContainText('GitHub returned 504 Gateway Timeout');
    await expect(banner).toContainText('Showing the last data from');
    await expect(banner).not.toContainText('unreachable');
    await expect(banner).not.toContainText('isn’t answering');
    await expect(banner.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test(`has no axe-core violations in light and dark mode`, async ({
    page,
  }) => {
    for (const colorScheme of ['light', 'dark'] as const) {
      await test.step(`${colorScheme}`, async () => {
        await page.emulateMedia({ colorScheme });
        await page.goto('/pull-requests.html');
        await expect(page.locator('#unreachable-banner')).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
});
