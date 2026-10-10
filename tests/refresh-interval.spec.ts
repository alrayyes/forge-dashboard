import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #809: the page used to hard-code a 30s poll and a 5s force-refresh lock,
// mirroring the server's config. The server now says how often to read
// (readIntervalSeconds) and answers a refresh inside its cooldown with the
// current snapshot plus Retry-After; the page follows both.
const now = new Date().toISOString();

function snapshot(extra: Record<string, unknown> = {}) {
  return {
    generatedAt: now,
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: [],
    issues: [],
    ...extra,
  };
}

async function signIn(page: Page, request: never, baseURL: string | undefined) {
  await registerViaInvite(
    page,
    request,
    baseURL,
    `refresh-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    'Refresh Test User',
  );
}

test.describe('refresh follows the server (#809)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await signIn(page, request as never, baseURL);
    await page.route('**/api/dashboard/stream', (route) =>
      route.fulfill({ status: 404, body: '{}' }),
    );
  });

  test('polls at the interval the server states, not a fixed 30s', async ({
    page,
  }) => {
    let reads = 0;
    await page.route('**/api/dashboard', (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      reads++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot({ readIntervalSeconds: 20 })),
      });
    });
    await page.clock.install({ time: new Date() });
    await page.goto('/');
    await expect.poll(() => reads).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    // Time stands still from here, so only fastForward moves it.
    await page.clock.pauseAt(new Date(Date.now() + 1_000));
    const base = reads;

    await page.clock.fastForward(15_000);
    await page.waitForTimeout(200);
    expect(reads).toBe(base);

    await page.clock.fastForward(5_000);
    await expect.poll(() => reads).toBeGreaterThan(base);
  });

  test('a refresh inside the cooldown renders the snapshot and locks the button for Retry-After', async ({
    page,
  }) => {
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot({ readIntervalSeconds: 30 })),
      }),
    );
    await page.route('**/api/dashboard/refresh*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Retry-After': '3' },
        body: JSON.stringify(
          snapshot({
            readIntervalSeconds: 30,
            issues: [
              {
                forge: 'github',
                repo: 'alrayyes/app',
                number: 9,
                title: 'From the cooldown snapshot',
                url: 'https://example.com/9',
                author: 'ryan',
                labels: [],
                createdAt: now,
                updatedAt: now,
              },
            ],
            openIssueCount: 1,
          }),
        ),
      }),
    );
    await page.clock.install({ time: new Date() });
    await page.goto('/issues.html');
    const button = page.locator('#force-refresh-button');
    await expect(button).toBeEnabled();
    await page.clock.pauseAt(new Date(Date.now() + 1_000));

    await button.click();
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(button).toBeDisabled();

    await page.clock.fastForward(2_000);
    await expect(button).toBeDisabled();
    await page.clock.fastForward(1_500);
    await expect(button).toBeEnabled();
  });

  test('a refresh that fetched carries no Retry-After and leaves the button usable', async ({
    page,
  }) => {
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot({ readIntervalSeconds: 30 })),
      }),
    );
    await page.route('**/api/dashboard/refresh*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot({ readIntervalSeconds: 30 })),
      }),
    );
    await page.goto('/');
    const button = page.locator('#force-refresh-button');
    await button.click();
    await expect(button).toBeEnabled();
  });
});
