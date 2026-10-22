import AxeBuilder from '@axe-core/playwright';
import { expect, type Route } from '@playwright/test';
import { test } from './server-fixture';

// After a restart the page shows the last run's rows before any forge has been
// asked. That start-up gap must read as "starting up", never as a forge outage;
// a fetch that really failed still reads as unreachable.

const savedAt = () => new Date(Date.now() - 5 * 60_000).toISOString();

type Forge = Record<string, unknown>;
const starting = (forge: string): Forge => ({
  forge,
  reachable: false,
  starting: true,
  repoCount: 1,
  staleSince: savedAt(),
});
const outage = (forge: string): Forge => ({
  forge,
  reachable: false,
  repoCount: 1,
  errorKind: 'unreachable',
  error: 'dial tcp: i/o timeout',
  staleSince: savedAt(),
});
const up = (forge: string): Forge => ({ forge, reachable: true, repoCount: 1 });

async function serve(
  page: import('@playwright/test').Page,
  state: { forges: Forge[] },
) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        readIntervalSeconds: 1,
        forges: state.forges,
        pullRequests: [],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
        firstRefreshDone: true,
      }),
    }),
  );
}

test.describe('start-up state', () => {
  test('restored forges read as starting up, not unreachable', async ({
    page,
  }) => {
    await serve(page, { forges: [starting('github'), starting('forgejo')] });
    await page.goto('/pull-requests.html');

    const chips = page.locator('#forge-health .forge-health');
    await expect(chips.first()).toContainText('loading');
    await expect(chips).toHaveCount(2);
    await expect(page.locator('#forge-health')).toContainText(
      'Starting up, showing data from',
    );
    await expect(page.locator('#forge-health')).not.toContainText(
      'unreachable',
    );
    await expect(page.locator('#unreachable-banner')).toHaveCount(0);
    await expect(page.locator('#forge-health .unreachable')).toHaveCount(0);

    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(axe.violations).toEqual([]);
  });

  test('the first answer replaces the notice with the real reachability', async ({
    page,
  }) => {
    const state = { forges: [starting('github'), starting('forgejo')] };
    await serve(page, state);
    await page.goto('/pull-requests.html');
    await expect(page.locator('#forge-health')).toContainText('loading');

    state.forges = [up('github'), outage('forgejo')];
    await expect(page.locator('#forge-health')).toContainText(
      'GitHub reachable',
    );
    await expect(page.locator('#forge-health')).toContainText(
      'Forgejo unreachable',
    );
    await expect(page.locator('#forge-health')).not.toContainText(
      'Starting up',
    );
    await expect(page.locator('#unreachable-banner')).toBeVisible();
  });

  test('the starting dot does not pulse', async ({ page }) => {
    await serve(page, { forges: [starting('github')] });
    await page.goto('/pull-requests.html');
    const dot = page.locator('#forge-health .forge-health.starting .pulse-dot');
    await expect(dot).toHaveCSS('animation-name', 'none');
    await expect(dot).toHaveCSS('box-shadow', 'none');
  });
});
