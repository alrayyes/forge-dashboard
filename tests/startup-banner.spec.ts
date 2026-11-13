import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3554: a restart (an OOM kill, a deploy) empties the server's memory and the
// first full refresh is the heaviest moment. A forge that has not answered in
// the first minutes is starting up, and the banner must not call it down.

const down = (extra: Record<string, unknown> = {}) => ({
  forge: 'github',
  reachable: false,
  repoCount: 1,
  errorKind: 'unreachable',
  error: 'dial tcp 140.82.121.6:443: i/o timeout',
  staleSince: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...extra,
});

function mockDashboard(
  page: Page,
  forges: unknown[],
  recentlyStarted: boolean,
) {
  return page.route(
    /\/api\/v1\/dashboard(\/refresh|\/stream)?(\?.*)?$/,
    (route: Route) => {
      if (route.request().url().includes('/stream')) return route.abort();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges,
          pullRequests: [],
          issues: [],
          recentlyStarted,
        }),
      });
    },
  );
}

test.describe('the banner right after a restart (#3554)', () => {
  test('says the forge is starting up, not unreachable, within five minutes of a start', async ({
    page,
  }) => {
    await mockDashboard(page, [down()], true);
    await page.goto('/pull-requests.html');

    const banner = page.locator('#unreachable-banner');
    await expect(banner).toContainText(/GitHub is starting up\./);
    await expect(banner).not.toContainText('unreachable');
    await expect(banner).toContainText('Showing data from');
    await expect(banner.getByRole('button', { name: 'Retry' })).toHaveCount(1);
  });

  test('keeps saying unreachable once the server has been up a while', async ({
    page,
  }) => {
    await mockDashboard(page, [down()], false);
    await page.goto('/pull-requests.html');

    await expect(page.locator('#unreachable-banner')).toContainText(
      'GitHub is unreachable.',
    );
  });

  test('a bad token is still reported as one right after a restart', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      [down({ errorKind: 'unauthorized', error: 'bad credentials' })],
      true,
    );
    await page.goto('/pull-requests.html');

    await expect(page.locator('#unreachable-banner')).toContainText(
      'Check the token in Settings',
    );
  });
});
