import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The pages that draw no dashboard snapshot of their own take their numbers
// from the layout's navigation counts. That read follows the dashboard poll's
// rule: one read in flight, the next timed from each answer or failure at the
// interval the server advises, and a hung read gives up and polling goes on.
// https://github.com/alrayyes/forge-dashboard/issues/1770

test.use({ storageState: SHARED_STORAGE_STATE_PATH });

// `own` is the single read a page makes for itself on load (its forge list),
// which is not the layout's navigation-count read and is left out of the count.
const PAGES = [
  { name: 'Branches', url: '/', own: 0 },
  { name: 'Insights', url: '/insights.html', own: 1 },
  { name: 'Settings', url: '/settings.html', own: 1 },
  { name: 'Webhooks', url: '/webhooks.html', own: 1 },
];

const isRead = (url: string) => new URL(url).pathname === '/api/dashboard';

// Counts the reads of /api/dashboard that were started and not yet ended.
function trackReads(page: Page) {
  const seen = { started: 0, open: 0, max: 0, ended: 0 };
  page.on('request', (req) => {
    if (!isRead(req.url())) return;
    seen.started += 1;
    seen.open += 1;
    seen.max = Math.max(seen.max, seen.open);
  });
  const end = (req: { url(): string }) => {
    if (!isRead(req.url())) return;
    seen.open -= 1;
    seen.ended += 1;
  };
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  return seen;
}

// The page's clock stands still until the test moves it.
async function freezeClock(page: Page) {
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
}

async function noStream(page: Page) {
  await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
}

for (const { name, url, own } of PAGES) {
  test.describe(`${name}: one navigation-count read at a time (#1770)`, () => {
    test('a held read is never joined by a second, and polling outlives it', async ({
      page,
    }) => {
      await freezeClock(page);
      await noStream(page);
      // Never answers: a half-open connection.
      await page.route('**/api/dashboard*', (route: Route) =>
        isRead(route.request().url()) ? undefined : route.fallback(),
      );
      const seen = trackReads(page);
      await page.goto(url);
      await expect.poll(() => seen.started - own).toBe(1);

      // The read gives up at 20 s, the next goes 30 s after that.
      for (let i = 0; i < 70; i++) await page.clock.runFor(1000);
      expect(seen.started - own).toBeGreaterThanOrEqual(2);
      expect(seen.max).toBeLessThanOrEqual(1 + own);
    });

    test('the retry follows the advised interval, not a fixed one', async ({
      page,
    }) => {
      await freezeClock(page);
      await noStream(page);
      await page.route('**/api/dashboard*', (route: Route) =>
        isRead(route.request().url())
          ? route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                generatedAt: '0001-01-01T00:00:00Z',
                readIntervalSeconds: 2,
                firstRefreshDone: false,
                forges: [],
                pullRequests: [],
                issues: [],
              }),
            })
          : route.fallback(),
      );
      const seen = trackReads(page);
      await page.goto(url);
      await expect.poll(() => seen.started - own).toBe(1);

      // The page's clock stands still until its answer has been handled, so
      // the retry is timed from there.
      await expect.poll(() => seen.ended).toBe(1 + own);
      await page.waitForTimeout(150);
      await page.clock.runFor(1900);
      expect(seen.started - own).toBe(1);
      await page.clock.runFor(200);
      await expect.poll(() => seen.started - own).toBe(2);
      await expect.poll(() => seen.ended).toBe(2 + own);
      await page.waitForTimeout(150);
      await page.clock.runFor(2100);
      await expect.poll(() => seen.started - own).toBe(3);
      expect(seen.max).toBeLessThanOrEqual(1 + own);
    });
  });
}
