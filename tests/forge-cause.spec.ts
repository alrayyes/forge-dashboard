import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { mainBranchPageOf } from './nav-counts-helper';
import { test } from './server-fixture';

// Rows held from an earlier read are not "Live": the server says why with
// `cause` on a forge's health, and the page words it (#4998).

type Health = Record<string, unknown>;

const savedAt = () => new Date(Date.now() - 5 * 60_000).toISOString();
const good = () => forgeHealth('github');
const slow = () =>
  forgeHealth('github', { cause: 'slow', rowsReadAt: savedAt() });
const starting = () =>
  forgeHealth('github', {
    reachable: false,
    starting: true,
    cause: 'starting',
    staleSince: savedAt(),
  });
const down = () =>
  forgeHealth('github', {
    reachable: false,
    errorKind: 'unreachable',
    error: 'dial tcp: i/o timeout',
    staleSince: savedAt(),
  });

// The stream is cut, so each change arrives with the page's next read.
async function serve(page: Page, state: { forge: Health }) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        readIntervalSeconds: 1,
        forges: [state.forge],
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
        firstRefreshDone: true,
      }),
    }),
  );
}

const status = (page: Page) => page.locator('.live-control .live-status');

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('forge cause (#4998)', () => {
  test('saved rows after a restart read as starting up, never unreachable', async ({
    page,
  }) => {
    await serve(page, { forge: starting() });
    await page.goto('/pull-requests.html');

    await expect(status(page)).toHaveText('Starting up');
    await expect(page.locator('#forge-health')).toContainText(
      'GitHub starting up',
    );
    await expect(page.locator('#unreachable-banner')).toHaveCount(0);
    await expect(page.getByText(/GitHub (is )?unreachable/)).toHaveCount(0);
    await expectAccessible(page);
  });

  test('a held pass reads slow to answer, and Live again after a good read', async ({
    page,
  }) => {
    const state = { forge: slow() };
    await serve(page, state);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/pull-requests.html');
    const age = page.locator('#forge-health .forge-health-stale');

    await expect(status(page)).toHaveText('Slow to answer');
    await expect(age).toHaveText('Slow to answer, showing data from 5m ago');
    await expect(page.locator('#forge-health')).toContainText(
      'GitHub slow to answer',
    );
    await expect(page.locator('#forge-health-live')).toContainText(
      'GitHub slow to answer',
    );
    await expect(page.locator('#unreachable-banner')).toHaveCount(0);
    await expectAccessible(page);

    state.forge = good();
    await expect(status(page)).toHaveText('Live');
    await expect(page.locator('#forge-health')).not.toContainText(
      'slow to answer',
    );
    await expect(age).toHaveCount(0);
  });

  // The age counts on while nothing else changes (#5023).
  test('the age of held rows ticks without a new read', async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [slow()],
      pullRequests: [],
      issues: [],
    });
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.request().url().includes('/stream')
        ? route.abort()
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body,
          }),
    );
    await page.goto('/pull-requests.html');
    const age = page.locator('#forge-health .forge-health-stale');
    await expect(age).toContainText('5m ago');

    await page.clock.fastForward(120_000);
    await expect(age).toContainText('7m ago');
  });

  test('a forge that goes from slow to down shows the unreachable banner', async ({
    page,
  }) => {
    const state = { forge: slow() };
    await serve(page, state);
    await page.goto('/pull-requests.html');
    await expect(status(page)).toHaveText('Slow to answer');

    state.forge = down();
    await expect(page.locator('#unreachable-banner')).toContainText(
      'GitHub is unreachable.',
    );
    await expect(page.locator('#forge-health')).not.toContainText(
      'slow to answer',
    );
    await expectAccessible(page);
  });

  test('the Issues and Main branches controls say it too', async ({ page }) => {
    await serve(page, { forge: slow() });
    await page.route('**/api/v1/main-branches', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...mainBranchPageOf(['passed']),
          forges: [slow()],
          generatedAt: new Date().toISOString(),
        }),
      }),
    );

    await page.goto('/issues.html');
    await expect(status(page)).toHaveText('Slow to answer');

    await page.goto('/');
    await expect(status(page)).toHaveText('Slow to answer');
    await expectAccessible(page);
  });
});
