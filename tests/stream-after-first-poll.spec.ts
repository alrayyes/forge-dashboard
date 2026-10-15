import { expect, type Route } from '@playwright/test';
import { test } from './fixtures';
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
      if (route.request().url().includes('/stream')) return route.fallback();
      await held;
      return route.fulfill({ json: snapshot() });
    });
    await page.goto('/pull-requests.html');
    await page.waitForTimeout(500);
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
      if (route.request().url().includes('/stream')) return route.fallback();
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

  test('a page with nothing configured does not open the stream', async ({
    page,
  }) => {
    let streamRequests = 0;
    await page.route('**/api/dashboard/stream*', (route: Route) => {
      streamRequests++;
      return route.abort();
    });
    await page.route('**/api/dashboard*', (route: Route) => {
      if (route.request().url().includes('/stream')) return route.fallback();
      return route.fulfill({
        json: {
          ...snapshot(),
          forges: [],
          generatedAt: '0001-01-01T00:00:00Z',
        },
      });
    });
    await page.goto('/pull-requests.html');
    await expect(page.locator('#forge-health')).toBeAttached();
    await page.waitForTimeout(1000);
    expect(streamRequests).toBe(0);
  });
});
