import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// Insights, Settings and Webhooks take their data from the layout's one
// /api/dashboard read (#1801). While the first refresh runs the server answers
// with an empty `firstRefreshDone:false` snapshot, so the pages must follow the
// later answers until one is done. A read that was aborted or hit a 5xx must
// not freeze a page on its empty state; a 4xx is final.

test.use({ storageState: SHARED_STORAGE_STATE_PATH });

const PAGES = [
  {
    name: 'Insights',
    url: '/insights.html',
    shows: '#insights-tracked',
    text: '3 repositories tracked',
    empty: '0 repositories tracked',
    redirects: true,
  },
  {
    name: 'Settings',
    url: '/settings.html',
    shows: '#webhook-coverage-count',
    text: '1 of 2 confirmed',
    empty: undefined,
    redirects: false,
  },
  {
    name: 'Webhooks',
    url: '/webhooks.html',
    shows: '#webhooks-table',
    text: 'alrayyes/held',
    empty: 'Nothing tracked yet',
    redirects: true,
  },
];

const isRead = (url: string) => new URL(url).pathname === '/api/dashboard';

const REPOS = [
  { forge: 'github', fullName: 'alrayyes/held', hasWebhook: true },
  { forge: 'github', fullName: 'alrayyes/other', hasWebhook: false },
];

const body = (done: boolean, full: boolean) => ({
  readIntervalSeconds: 2,
  firstRefreshDone: done,
  forges: full ? [{ forge: 'github', repoCount: 3 }] : [],
  repos: full ? REPOS : [],
  pullRequests: [],
  issues: [],
});

type Step = 'hold' | number | ReturnType<typeof body>;

// Answers the nth /api/dashboard request with the nth step (the last repeats):
// 'hold' never answers, a number is an HTTP status, an object is a 200 body.
async function script(page: Page, steps: Step[]) {
  const seen = { started: 0, open: 0, max: 0 };
  await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/dashboard*', (route: Route) => {
    if (!isRead(route.request().url())) return route.fallback();
    const step = steps[Math.min(seen.started, steps.length - 1)];
    seen.started += 1;
    seen.open += 1;
    seen.max = Math.max(seen.max, seen.open);
    if (step === 'hold') {
      // Never answers; the layout's abort ends it.
      page.once('requestfailed', () => {
        seen.open -= 1;
      });
      return;
    }
    seen.open -= 1;
    if (typeof step === 'number')
      return route.fulfill({ status: step, body: '{}' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(step),
    });
  });
  return seen;
}

async function freezeClock(page: Page) {
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
}

// Moves the page's clock, a second at a time so each read's answer lands
// between steps.
async function advance(page: Page, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    await page.clock.runFor(1000);
    await page.evaluate(() => new Promise((r) => queueMicrotask(r as never)));
  }
}

for (const { name, url, shows, text, empty, redirects } of PAGES) {
  test.describe(`${name}: the layout's dashboard read (#1801)`, () => {
    test('follows the answers of a first refresh until one is done', async ({
      page,
    }) => {
      await freezeClock(page);
      const seen = await script(page, [body(false, false), body(true, true)]);
      await page.goto(url);
      await expect.poll(() => seen.started).toBe(1);
      if (empty) await expect(page.getByText(text)).toHaveCount(0);
      await advance(page, 4);
      await expect(page.locator(shows)).toContainText(text);
      expect(seen.max).toBe(1);
    });

    test('a read that hit the 20 s abort leaves the page waiting for the next answer', async ({
      page,
    }) => {
      await freezeClock(page);
      const seen = await script(page, ['hold', body(true, true)]);
      await page.goto(url);
      await expect.poll(() => seen.started).toBe(1);
      await advance(page, 55);
      await expect(page.locator(shows)).toContainText(text);
      expect(seen.max).toBe(1);
    });

    test('a 500 does not freeze the page, the next answer fills it', async ({
      page,
    }) => {
      await freezeClock(page);
      const seen = await script(page, [500, body(true, true)]);
      await page.goto(url);
      await expect.poll(() => seen.started).toBe(1);
      await advance(page, 35);
      await expect(page.locator(shows)).toContainText(text);
      expect(seen.max).toBe(1);
    });

    test(`a 401 ${redirects ? 'sends the page to the login page, once' : 'leaves the page where it is'}`, async ({
      page,
    }) => {
      const logins: string[] = [];
      page.on('request', (req) => {
        if (new URL(req.url()).pathname === '/login.html')
          logins.push(req.url());
      });
      await script(page, [401]);
      await page.goto(url);
      if (redirects) await expect.poll(() => logins.length).toBe(1);
      else await page.waitForTimeout(1500);
      await page.waitForTimeout(500);
      expect(logins.length).toBe(redirects ? 1 : 0);
    });
  });
}

test('Webhooks: after a done answer a later poll does not replace the rows the person changed', async ({
  page,
}) => {
  await freezeClock(page);
  await page.route('**/api/repos/ignore', (r) => r.fulfill({ status: 204 }));
  const seen = await script(page, [body(true, true)]);
  await page.goto('/webhooks.html');
  await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
  await page
    .locator('#webhooks-rows tr')
    .first()
    .getByRole('combobox', { name: 'Ignore alrayyes/held' })
    .selectOption('both');
  await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
  const before = seen.started;
  await advance(page, 5);
  await expect.poll(() => seen.started).toBeGreaterThan(before);
  await page.waitForTimeout(300);
  await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
  await expect(page.locator('#webhooks-ignored summary')).toContainText(
    'Ignored (1)',
  );
});
