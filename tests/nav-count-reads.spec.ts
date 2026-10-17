import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The pages that draw no dashboard snapshot of their own take their numbers
// from the layout's navigation counts. That read follows the dashboard poll's
// rule: one read in flight, the next timed from each answer or failure at the
// interval the server advises, and a hung read gives up and polling goes on.
// https://github.com/alrayyes/forge-dashboard/issues/1770

test.use({ storageState: SHARED_STORAGE_STATE_PATH });

// Page and layout make one read between them (#1801): Insights, Settings and
// Webhooks take their forge list from the layout's read, not their own.
const PAGES = [
  { name: 'Branches', url: '/' },
  { name: 'Insights', url: '/insights.html' },
  { name: 'Settings', url: '/settings.html' },
  { name: 'Webhooks', url: '/webhooks.html' },
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

// Records, on the page's own clock, every read the layout makes: the layout is
// the only caller that passes an abort signal. Playwright's routing bypasses
// the browser's HTTP cache, so the cache lock a same-URL read can sit behind
// cannot be staged here; what can be pinned is that the layout opts out of it.
async function spyLayoutReads(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __reads: { start: number; end: number; cache?: string }[];
    };
    w.__reads = [];
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (
        !init?.signal ||
        new URL(url, location.href).pathname !== '/api/dashboard'
      )
        return real(input, init);
      const rec = { start: Date.now(), end: -1, cache: init.cache };
      w.__reads.push(rec);
      return real(input, init).finally(() => {
        rec.end = Date.now();
      });
    };
  });
}

const layoutReads = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __reads: { start: number; end: number; cache?: string }[];
        }
      ).__reads,
  );

async function noStream(page: Page) {
  await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
}

// What each of the three pages draws from the layout's read, so a held first
// read and its late answer are shown to reach the page (#1801).
const FROM_READ = [
  {
    name: 'Insights',
    url: '/insights.html',
    shows: '#insights-tracked',
    text: '3 repositories tracked',
  },
  {
    name: 'Settings',
    url: '/settings.html',
    shows: '#webhook-coverage-count',
    text: '1 of 2 confirmed',
  },
  {
    name: 'Webhooks',
    url: '/webhooks.html',
    shows: '#webhooks-table',
    text: 'alrayyes/held',
  },
];

for (const { name, url, shows, text } of FROM_READ) {
  test(`${name}: a held first read reaches the page when it answers, still one read (#1801)`, async ({
    page,
  }) => {
    await noStream(page);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/api/dashboard*', async (route: Route) => {
      if (!isRead(route.request().url())) return route.fallback();
      await held;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          readIntervalSeconds: 30,
          firstRefreshDone: true,
          forges: [{ forge: 'github', repoCount: 3 }],
          repos: [
            { forge: 'github', fullName: 'alrayyes/held', hasWebhook: true },
            { forge: 'github', fullName: 'alrayyes/other', hasWebhook: false },
          ],
          pullRequests: [],
          issues: [],
        }),
      });
    });
    const seen = trackReads(page);
    await page.goto(url);
    await expect.poll(() => seen.started).toBe(1);
    await expect(page.getByText(text)).toHaveCount(0);
    release();
    await expect(page.locator(shows)).toContainText(text);
    expect(seen.started).toBe(1);
  });
}

for (const { name, url } of PAGES) {
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
      await expect.poll(() => seen.started).toBe(1);

      // The read gives up at 20 s, the next goes 30 s after that.
      for (let i = 0; i < 70; i++) await page.clock.runFor(1000);
      expect(seen.started).toBeGreaterThanOrEqual(2);
      expect(seen.max).toBeLessThanOrEqual(1);
    });

    test('the retry follows the advised interval, not a fixed one', async ({
      page,
    }) => {
      await freezeClock(page);
      await noStream(page);
      await spyLayoutReads(page);
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
      await expect.poll(() => seen.started).toBe(1);

      // The page's clock stands still until the test moves it, so the gap
      // between an answer and the next request is measured on that clock.
      const answered = (n: number) =>
        expect
          .poll(async () => (await layoutReads(page))[n]?.end ?? -1)
          .toBeGreaterThan(0);
      await answered(0);
      let steps = 0;
      while (seen.started < 2 && steps++ < 60) {
        await page.clock.runFor(100);
        await page.evaluate(
          () => new Promise((r) => queueMicrotask(r as never)),
        );
      }
      const reads = await layoutReads(page);
      const [first, second] = reads;
      expect(second).toBeDefined();
      expect(second.start - first.end).toBeGreaterThanOrEqual(2000);
      expect(second.start - first.end).toBeLessThanOrEqual(2400);
      expect(seen.started).toBe(2);
      await answered(1);
      for (let i = 0; seen.started < 3 && i < 60; i++) {
        await page.clock.runFor(100);
        await page.evaluate(
          () => new Promise((r) => queueMicrotask(r as never)),
        );
      }
      const [, answeredSecond, third] = await layoutReads(page);
      expect(third.start - answeredSecond.end).toBeGreaterThanOrEqual(2000);
      expect(third.start - answeredSecond.end).toBeLessThanOrEqual(2400);
      expect(seen.max).toBeLessThanOrEqual(1);
    });

    test('page and layout together make one read on load and one per poll', async ({
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
                readIntervalSeconds: 30,
                firstRefreshDone: true,
                forges: [],
                repos: [],
                pullRequests: [],
                issues: [],
              }),
            })
          : route.fallback(),
      );
      const seen = trackReads(page);
      await page.goto(url);
      await expect.poll(() => seen.ended).toBe(1);
      expect(seen.started).toBe(1);

      // One poll interval later: one more read, not one per reader.
      for (let i = 0; seen.started < 2 && i < 40; i++) {
        await page.clock.runFor(1000);
        await page.evaluate(
          () => new Promise((r) => queueMicrotask(r as never)),
        );
      }
      await expect.poll(() => seen.ended).toBe(2);
      expect(seen.started).toBe(2);
      expect(seen.max).toBe(1);
    });

    test("the read opts out of the HTTP cache, so it is never queued behind another reader's", async ({
      page,
    }) => {
      await freezeClock(page);
      await noStream(page);
      await spyLayoutReads(page);
      await page.route('**/api/dashboard*', (route: Route) =>
        isRead(route.request().url())
          ? route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                forges: [],
                pullRequests: [],
                issues: [],
              }),
            })
          : route.fallback(),
      );
      await page.goto(url);
      await expect.poll(async () => (await layoutReads(page)).length).toBe(1);
      expect((await layoutReads(page)).map((r) => r.cache)).toEqual([
        'no-store',
      ]);
    });
  });
}
