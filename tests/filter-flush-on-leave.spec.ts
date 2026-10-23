import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #1620: free text is saved to the server 500 ms after the last keystroke.
// Leaving the page inside that window used to lose the value from the server
// copy. The page now sends it as it goes. Each test fills a box and loads
// another page straight away, then reads the cookie and the server copy and
// comes back. The saved state is on the server, so this spec registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/1620

const ISSUES = [1, 2].map((number) => ({
  forge: 'github',
  repo: 'acme/app',
  number,
  title: number === 1 ? 'Weekly report' : 'Real work',
  url: `https://example.com/issues/${number}`,
  author: 'ryan',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}));

async function stub(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

const serverCopy = async (page: Page) =>
  JSON.stringify(
    await (await page.request.get('/api/settings/filter-state')).json(),
  );

const cookieCopy = async (page: Page) => {
  const cookies = await page.context().cookies();
  const c = cookies.find((x) => x.name === 'forge-board-filters');
  return c ? decodeURIComponent(c.value) : '';
};

test.describe('a value typed just before leaving is kept (#1620)', () => {
  test.beforeEach(async ({ page }) => {
    await stub(page);
    await page.goto('/issues.html');
    await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
  });

  for (const [name, selector] of [
    ['title search', 'input[data-col="title"]'],
    ['hide-titles pattern', '#issue-hide-title-regex'],
  ] as const) {
    test(`the ${name} survives leaving within the debounce window`, async ({
      page,
    }) => {
      const value = 'zqxjk';
      await page.locator(selector).fill(value);
      // A full load of another page: pagehide is the only chance to save.
      await page.goto('/pull-requests.html');

      await expect
        .poll(() => serverCopy(page), { timeout: 5000 })
        .toContain(value);
      expect(await cookieCopy(page)).toContain(value);

      await page.goto('/issues.html');
      await expect(page.locator(selector)).toHaveValue(value);
    });
  }

  test('hiding the tab saves at once, a second value saves after coming back, and hidden then pagehide sends once', async ({
    page,
  }) => {
    const puts: string[] = [];
    await page.route('**/api/settings/filter-state', (route) => {
      if (route.request().method() === 'PUT')
        puts.push(route.request().postData() ?? '');
      return route.fallback();
    });
    const show = (state: 'hidden' | 'visible') =>
      page.evaluate((v) => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => v,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    const input = page.locator('input[data-col="title"]');

    await input.fill('first');
    await show('hidden');
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('first');
    expect(puts).toHaveLength(1);

    // Leaving for good right after hiding has nothing left to send.
    await page.evaluate(() => dispatchEvent(new Event('pagehide')));
    expect(puts).toHaveLength(1);

    await show('visible');
    await input.fill('second');
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('second');
    expect(puts).toHaveLength(2);
  });
});
