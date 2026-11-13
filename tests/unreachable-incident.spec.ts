import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3633: when GitHub is unreachable and its own status page reports an
// incident, the banner says so in a second sentence. Nothing extra otherwise.

const status = {
  indicator: 'minor',
  incidents: ['Degraded performance'],
  components: ['Pull Requests'],
};

const github = (providerStatus?: unknown) => ({
  forge: 'github',
  reachable: false,
  repoCount: 1,
  errorKind: 'unreachable',
  error: 'dial tcp: i/o timeout',
  staleSince: new Date(Date.now() - 3 * 3600_000).toISOString(),
  ...(providerStatus ? { providerStatus } : {}),
});
const forgejo = { forge: 'forgejo', reachable: true, repoCount: 1 };

async function open(page: Page, forges: unknown[]) {
  await page.route('**/api/v1/dashboard*', (route: Route) => {
    if (route.request().url().includes('/stream')) return route.abort();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
        pullRequests: [],
        issues: [],
      }),
    });
  });
  await page.goto('/pull-requests.html');
}

for (const width of [360, 390, 1280]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`incident at ${width}px, ${scheme}: second sentence in the one banner, axe clean`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, [github(status), forgejo]);

      const banner = page.locator('#unreachable-banner');
      await expect(page.locator('.unreachable-banner')).toHaveCount(1);
      await expect(banner).toHaveText(
        /^GitHub is unreachable\. Showing data from .+, 3h ago\. Retrying automatically\. GitHub reports an incident: Degraded performance\. Affects: Pull Requests\.\s*GitHub status\s*Retry$/,
      );
      // The incident is on its own line under the first sentence.
      const incident = banner.locator('.unreachable-banner-incident');
      const first = await banner.locator('strong').boundingBox();
      const second = await incident.boundingBox();
      expect(second?.y ?? 0).toBeGreaterThan(
        (first?.y ?? 0) + (first?.height ?? 0) - 1,
      );

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('no incident reported: the banner is the same as before', async ({
  page,
}) => {
  await open(page, [github({ indicator: 'none' }), forgejo]);

  const banner = page.locator('#unreachable-banner');
  await expect(banner).toHaveText(
    /^GitHub is unreachable\. Showing data from .+, 3h ago\. Retrying automatically\.\s*GitHub status\s*Retry$/,
  );
  await expect(banner).not.toContainText('incident');
});

test('no status answer at all: the banner is the same as before', async ({
  page,
}) => {
  await open(page, [github(), forgejo]);

  await expect(page.locator('#unreachable-banner')).not.toContainText(
    'reports',
  );
});
