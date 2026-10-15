import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { settle } from './settle-helper';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The tests mock /api/dashboard and the stream and write nothing per user, so
// they start from the shared session instead of registering a user each.
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

// #1569: the stream answers 404 until the user's background refresh runs, and
// EventSource never retries a non-200. The page opens it after the first poll,
// and opens it again when it closed.

function snapshot(forge: Record<string, unknown> = {}) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', repoCount: 1, reachable: true, ...forge }],
    pullRequests: [],
    issues: [],
    repos: [],
    hiddenDrafts: 0,
  };
}

const isStream = (url: string) => url.includes('/api/dashboard/stream');

// A macrotask round trip that a fake clock does not fake: the page has run
// what the last response queued.
const flush = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      }),
  );

test.describe('live stream start (#1569)', () => {
  test('is not requested before the first poll has answered', async ({
    page,
  }) => {
    let streamRequests = 0;
    let releasePoll: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    await page.route('**/api/dashboard/stream*', (route: Route) => {
      streamRequests++;
      return route.abort();
    });
    await page.route('**/api/dashboard*', async (route: Route) => {
      if (isStream(route.request().url())) return route.fallback();
      await held;
      return route.fulfill({ json: snapshot() });
    });
    const polled = page.waitForRequest(
      (req) => !isStream(req.url()) && req.url().includes('/api/dashboard'),
    );
    await page.goto('/pull-requests.html');
    await polled;
    await settle(page);
    expect(streamRequests).toBe(0);

    releasePoll();
    await expect.poll(() => streamRequests).toBeGreaterThan(0);
  });

  test('a stream that answered 404 is reopened and its snapshots apply', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    let streamRequests = 0;
    await page.route('**/api/dashboard/stream*', (route: Route) => {
      streamRequests++;
      if (streamRequests === 1) {
        return route.fulfill({
          status: 404,
          json: { error: 'no background refresh is running yet for this user' },
        });
      }
      const pushed = snapshot({
        reachable: false,
        errorKind: 'unreachable',
        error: 'dial tcp: timeout',
        staleSince: new Date(Date.now() - 3 * 60_000).toISOString(),
      });

      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify(pushed)}\n\n`,
      });
    });
    await page.route('**/api/dashboard*', (route: Route) => {
      if (isStream(route.request().url())) return route.fallback();
      return route.fulfill({ json: snapshot() });
    });
    await page.goto('/pull-requests.html');

    await expect(page.locator('#forge-health')).toContainText(
      'Showing data from 3m ago',
      { timeout: 15_000 },
    );
    expect(streamRequests).toBeGreaterThan(1);
    // The mocked 404 is the one request the browser logs; nothing else is.
    expect(
      errors.filter((e) => !e.includes('status of 404')),
      'console errors',
    ).toEqual([]);
  });

  test('a page with nothing configured does not open the stream, poll after poll', async ({
    page,
  }) => {
    let streamRequests = 0;
    let polls = 0;
    await page.route('**/api/dashboard/stream*', (route: Route) => {
      streamRequests++;
      return route.abort();
    });
    await page.route('**/api/dashboard*', (route: Route) => {
      if (isStream(route.request().url())) return route.fallback();
      polls++;
      return route.fulfill({
        json: {
          ...snapshot(),
          forges: [],
          generatedAt: '0001-01-01T00:00:00Z',
        },
      });
    });
    await page.clock.install();
    await page.goto('/pull-requests.html');
    await expect.poll(() => polls).toBe(1);
    await flush(page);
    expect(streamRequests).toBe(0);

    await page.clock.fastForward(60_000);
    await expect.poll(() => polls).toBeGreaterThan(1);
    await flush(page);
    expect(streamRequests).toBe(0);
  });

  test('retries stop after five closes and a later poll starts them again', async ({
    page,
  }) => {
    let streamRequests = 0;
    await page.route('**/api/dashboard/stream*', (route: Route) => {
      streamRequests++;
      return route.fulfill({ status: 404, json: { error: 'none yet' } });
    });
    // The next poll is an hour away, so only the backoff can reopen it.
    await page.route('**/api/dashboard*', (route: Route) => {
      if (isStream(route.request().url())) return route.fallback();
      return route.fulfill({
        json: { ...snapshot(), readIntervalSeconds: 3600 },
      });
    });
    await page.clock.install();
    await page.goto('/pull-requests.html');
    await expect.poll(() => streamRequests).toBe(1);
    for (let i = 0; i < 8; i++) {
      await page.clock.fastForward(31_000);
      await flush(page);
    }
    expect(streamRequests).toBe(5);

    await page.clock.fastForward(3_600_000);
    await expect.poll(() => streamRequests).toBeGreaterThan(5);
  });

  test("a shared dashboard does not retry the viewer's own stream", async ({
    page,
  }) => {
    let streamRequests = 0;
    await page.route('**/api/sharing', (route: Route) =>
      route.fulfill({
        json: { sharedWithMe: [{ username: 'owner', displayName: 'Owner' }] },
      }),
    );
    await page.route('**/api/dashboard/stream*', (route: Route) => {
      streamRequests++;
      return route.fulfill({ status: 404, json: { error: 'none yet' } });
    });
    await page.route('**/api/dashboard*', (route: Route) => {
      if (isStream(route.request().url())) return route.fallback();
      return route.fulfill({ json: snapshot() });
    });
    await page.clock.install();
    await page.goto('/pull-requests.html');
    await expect.poll(() => streamRequests).toBe(1);
    await page.selectOption('#dashboard-owner-select', 'owner');
    await page.clock.fastForward(5_000);
    await flush(page);
    const before = streamRequests;
    await page.clock.fastForward(120_000);
    await flush(page);
    expect(streamRequests).toBe(before);
  });
});
