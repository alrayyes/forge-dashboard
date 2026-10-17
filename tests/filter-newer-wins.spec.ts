import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1760: a filter typed just before a reload used to be overwritten by an older
// saved copy. The page applied the copy over the cookie, and the save of the
// typed text could lose the race to the next page's read of the copy. Every
// saved state now carries a revision, and the copy is applied unless the cookie
// is newer. Each test types over an older saved value, loses the save on its
// way out (held back, as a slow link would), reloads at once, and orders the
// copy's read and the lost save both ways. The saved state is per user, so
// this spec registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/1760

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

const ENDPOINT = '/api/settings/filter-state';
const title = (page: Page) => page.locator('input[data-col="title"]');
const serverCopy = async (page: Page) =>
  JSON.stringify(await (await page.request.get(ENDPOINT)).json());

test.describe('the newer saved state wins (#1760)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `filter-newer-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Filter Newer Wins',
    );
    await stub(page);
    await page.goto('/issues.html');
    await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
    // An older value is saved first, so the server holds a copy to lose to.
    await title(page).fill('real');
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('real');
  });

  // Types a new value and reloads at once. The page's save of it never reaches
  // the server (the fetch is swapped out before the page goes away); lost.body
  // is what it would have sent, which is what the cookie now holds. onCopy runs
  // when the reloaded page asks for the saved copy, which is answered from the
  // old copy.
  async function typeAndReload(
    page: Page,
    onCopy: (lost: { body: string }) => Promise<void>,
  ) {
    const lost = { body: '' };
    await page.route(`**${ENDPOINT}`, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      await onCopy(lost);
      return route.fulfill({ response });
    });
    await title(page).fill('weekly');
    await page.evaluate(() => {
      const real = window.fetch;
      window.fetch = (input, init) =>
        init?.method === 'PUT'
          ? Promise.resolve(new Response(null, { status: 204 }))
          : real(input, init);
    });
    const cookie = (await page.context().cookies()).find(
      (c) => c.name === 'forge-board-filters',
    );
    lost.body = decodeURIComponent(cookie?.value ?? '{}');
    const answered = page.waitForResponse(
      (res) => res.url().endsWith(ENDPOINT) && res.request().method() === 'GET',
    );
    await page.reload();
    await answered;
    // Let the page apply the answer before anything is asserted.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => done(null))),
    );
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => done(null))),
    );
  }

  test('the copy is read before the save reaches the server', async ({
    page,
  }) => {
    await typeAndReload(page, async () => {});

    await expect(title(page)).toHaveValue('weekly');
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(page.locator('#issue-rows > .row')).toContainText('Weekly');
    // The page brings the server up to date itself.
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('weekly');
  });

  test('the save reaches the server before the read is answered', async ({
    page,
  }) => {
    await typeAndReload(page, async (lost) => {
      // The read was served from the old copy; the save lands, then the old
      // answer reaches the page.
      const put = await page.request.put(ENDPOINT, {
        data: JSON.parse(lost.body),
      });
      expect(put.ok()).toBe(true);
    });

    await expect(title(page)).toHaveValue('weekly');
    await expect(page.locator('#issue-rows > .row')).toContainText('Weekly');
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('weekly');
  });

  test('a device with an older cookie still takes the newer copy', async ({
    page,
    browser,
    baseURL,
  }) => {
    await title(page).fill('weekly');
    await expect
      .poll(() => serverCopy(page), { timeout: 5000 })
      .toContain('weekly');

    const other = await browser.newContext({
      baseURL,
      storageState: await page.context().storageState(),
    });
    const stale = {
      rev: 1,
      shared: { title: 'stale' },
      pr: {},
      issue: { hideDependencyDashboard: '1' },
      view: {},
    };
    await other.addCookies([
      {
        name: 'forge-board-filters',
        value: encodeURIComponent(JSON.stringify(stale)),
        url: baseURL ?? '',
      },
    ]);
    const second = await other.newPage();
    await stub(second);
    await second.goto('/issues.html');
    await expect(title(second)).toHaveValue('weekly');
    await other.close();
  });
});
