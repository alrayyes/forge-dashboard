import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3745: the banner's relative age keeps counting while nothing else changes,
// and counting is not announced again.

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();
const down = (forge: string, staleSince: string) => ({
  forge,
  reachable: false,
  repoCount: 1,
  errorKind: 'unreachable',
  error: 'dial tcp: i/o timeout',
  staleSince,
});

async function open(page: Page, forges: unknown[]) {
  await page.clock.install({ time: new Date() });
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
  test(`the age ticks without a re-announcement at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, [down('github', minutesAgo(10))]);
    const banner = page.locator('#unreachable-banner');
    await expect(banner).toContainText('10m ago');

    // Mark the node and watch the live region: ticking may change the age's
    // own text, but must not replace the banner.
    await banner.evaluate((el) => {
      el.setAttribute('data-probe', 'same-node');
    });
    await page.clock.fastForward(120_000);
    await expect(banner).toContainText('12m ago');
    await expect(banner).toHaveAttribute('data-probe', 'same-node');
    await expect(banner.locator('[aria-live="off"]')).toHaveText('12m ago');
    await expect(banner).toHaveAttribute('role', 'status');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('both forges down: the oldest data is the age that ticks', async ({
  page,
}) => {
  await open(page, [
    down('github', minutesAgo(5)),
    down('forgejo', minutesAgo(30)),
  ]);
  const banner = page.locator('#unreachable-banner');
  await expect(banner).toContainText('30m ago');
  await page.clock.fastForward(60_000);
  await expect(banner).toContainText('31m ago');
  await expect(banner).not.toContainText('6m ago');
});
