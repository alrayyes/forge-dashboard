import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// Every nav item shows how many items its page lists and how many of them are
// failing: a neutral total, then a red failed count with a warning glyph,
// shown only above zero. Design: docs/design/1315-nav-counts. The counts come
// from `navCounts` on /api/dashboard; the page only draws them.
// https://github.com/alrayyes/forge-dashboard/issues/1315

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `nav-pills-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Nav Pills');
}

type Pair = { total: number; failed: number };
type Counts = {
  branches: Pair;
  pullRequests: Pair;
  issues: { total: number };
  releases: Pair;
  bots: Pair;
};

const MIXED: Counts = {
  branches: { total: 12, failed: 3 },
  pullRequests: { total: 27, failed: 5 },
  issues: { total: 9 },
  releases: { total: 2, failed: 0 },
  bots: { total: 14, failed: 1 },
};

const CLEAN: Counts = {
  branches: { total: 12, failed: 0 },
  pullRequests: { total: 24, failed: 0 },
  issues: { total: 9 },
  releases: { total: 2, failed: 0 },
  bots: { total: 8, failed: 0 },
};

function snapshot(navCounts: Counts) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: [],
    issues: [],
    navCounts,
  };
}

// The answer changes with `state.counts`, so a test can say what a refresh
// finds.
async function serve(page: Page, state: { counts: Counts }) {
  const answer = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(state.counts)),
    });
  await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/dashboard*', answer);
  await page.route('**/api/dashboard/refresh*', answer);
}

const header = (page: Page, href: string) =>
  page.locator(`.app-nav a[href="${href}"]`);
const tab = (page: Page, href: string) =>
  page.locator(`.bottom-nav a[href="${href}"]`);

test.describe('nav counts: a total and a red failed count (#1315)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('Branches shows the total and a red failed count, and says both in its name', async ({
    page,
  }) => {
    await serve(page, { counts: MIXED });
    await page.goto('/settings.html');

    const link = header(page, '/');
    await expect(link.locator('.nav-total')).toHaveText('12');
    await expect(link.locator('.nav-failed')).toHaveText('3');
    await expect(link).toHaveAccessibleName('Branches, 12 total, 3 failing');
  });

  test('Pull requests, Releases and Bots each show a total and, when some fail, a failed count', async ({
    page,
  }) => {
    await serve(page, { counts: MIXED });
    await page.goto('/settings.html');

    await expect(
      header(page, '/pull-requests.html').locator('.nav-total'),
    ).toHaveText('27');
    await expect(
      header(page, '/pull-requests.html').locator('.nav-failed'),
    ).toHaveText('5');
    await expect(header(page, '/bots.html').locator('.nav-total')).toHaveText(
      '14',
    );
    await expect(header(page, '/bots.html').locator('.nav-failed')).toHaveText(
      '1',
    );
    await expect(
      header(page, '/releases.html').locator('.nav-total'),
    ).toHaveText('2');
  });

  test('Issues has no failing notion, so it shows the total only', async ({
    page,
  }) => {
    await serve(page, { counts: MIXED });
    await page.goto('/settings.html');

    const link = header(page, '/issues.html');
    await expect(link.locator('.nav-total')).toHaveText('9');
    await expect(link.locator('.nav-failed')).toHaveCount(0);
    await expect(link).toHaveAccessibleName('Issues, 9 total');
  });

  test('nothing failing shows no red number, and no empty pill', async ({
    page,
  }) => {
    await serve(page, { counts: CLEAN });
    await page.goto('/settings.html');

    await expect(page.locator('.app-nav .nav-failed')).toHaveCount(0);
    await expect(header(page, '/')).toHaveAccessibleName('Branches, 12 total');
  });

  test('a zero is never drawn: Branches with no rows has no pill at all', async ({
    page,
  }) => {
    await serve(page, {
      counts: { ...CLEAN, branches: { total: 0, failed: 0 } },
    });
    await page.goto('/settings.html');

    await expect(header(page, '/')).toBeVisible();
    await expect(header(page, '/').locator('.nav-total')).toHaveCount(0);
    await expect(header(page, '/')).toHaveAccessibleName('Branches');
  });

  test('a page with nothing to show leaves the nav, as before (#1228)', async ({
    page,
  }) => {
    await serve(page, {
      counts: {
        ...CLEAN,
        issues: { total: 0 },
        releases: { total: 0, failed: 0 },
        bots: { total: 0, failed: 0 },
      },
    });
    await page.goto('/settings.html');
    await expect(header(page, '/')).toBeVisible();

    for (const href of ['/issues.html', '/releases.html', '/bots.html'])
      await expect(header(page, href)).toHaveCount(0);
  });

  test('red is never alone: every failed pill carries a warning glyph', async ({
    page,
  }) => {
    await serve(page, { counts: MIXED });
    await page.goto('/settings.html');

    const failed = page.locator('.app-nav .nav-failed');
    await expect(failed).toHaveCount(3);
    for (const pill of await failed.all())
      await expect(pill.locator('svg[aria-hidden="true"]')).toHaveCount(1);
  });

  test('a refresh changes the numbers without a reload', async ({ page }) => {
    const state = { counts: MIXED };
    await serve(page, state);
    await page.goto('/pull-requests.html');
    await expect(header(page, '/').locator('.nav-failed')).toHaveText('3');

    state.counts = { ...MIXED, branches: { total: 13, failed: 0 } };
    await page.locator('#force-refresh-button').click();

    await expect(header(page, '/').locator('.nav-total')).toHaveText('13');
    await expect(header(page, '/').locator('.nav-failed')).toHaveCount(0);
  });

  // The pages that load no snapshot of their own (Branches, Insights,
  // Settings…) ask for the counts once, so they have to ask again or the
  // numbers go stale while the page is open.
  for (const path of ['/settings.html', '/insights.html']) {
    test(`${path} keeps the numbers current without a reload`, async ({
      page,
    }) => {
      const state = { counts: MIXED };
      await page.clock.install();
      await serve(page, state);
      await page.goto(path);
      await expect(header(page, '/').locator('.nav-failed')).toHaveText('3');

      state.counts = { ...MIXED, branches: { total: 12, failed: 0 } };
      await page.clock.runFor(31_000);

      await expect(header(page, '/').locator('.nav-failed')).toHaveCount(0);
      await expect(header(page, '/')).toHaveAccessibleName(
        'Branches, 12 total',
      );
    });
  }

  test('the Branches page keeps the numbers current without a reload', async ({
    page,
  }) => {
    const state = { counts: MIXED };
    await page.clock.install();
    await serve(page, state);
    await page.route('**/api/main-branches', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          counts: { failed: 0, running: 0, passed: 0, none: 0, total: 0 },
          branches: [],
        }),
      }),
    );
    await page.goto('/');
    await expect(header(page, '/').locator('.nav-failed')).toHaveText('3');

    state.counts = { ...MIXED, branches: { total: 12, failed: 5 } };
    await page.clock.runFor(31_000);

    await expect(header(page, '/').locator('.nav-failed')).toHaveText('5');
  });

  // A hidden tab has nobody to show the numbers to, so it does not ask; and a
  // tab that becomes visible again asks at once instead of waiting out the
  // interval.
  test('a hidden tab does not poll, and showing it again reads at once', async ({
    page,
  }) => {
    const state = { counts: MIXED };
    let reads = 0;
    await page.clock.install();
    await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
    await page.route('**/api/dashboard*', (route: Route) => {
      reads += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(state.counts)),
      });
    });
    await page.goto('/settings.html');
    await expect(header(page, '/').locator('.nav-failed')).toHaveText('3');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => true,
      });
    });
    const before = reads;

    await page.clock.runFor(95_000);
    expect(reads).toBe(before);

    state.counts = { ...MIXED, branches: { total: 12, failed: 0 } };
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(header(page, '/').locator('.nav-failed')).toHaveCount(0);
  });

  test('a page that loads its own snapshot does not poll the counts a second time', async ({
    page,
  }) => {
    let reads = 0;
    await page.clock.install();
    await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
    await page.route(/\/api\/dashboard(\/refresh)?(\?.*)?$/, (route: Route) => {
      reads += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...snapshot(MIXED), readIntervalSeconds: 600 }),
      });
    });
    await page.goto('/pull-requests.html');
    await expect(header(page, '/').locator('.nav-failed')).toHaveText('3');
    const before = reads;

    await page.clock.runFor(95_000);

    // The page's own poll may read; the layout adds none of its own.
    expect(reads - before).toBeLessThanOrEqual(0);
  });

  test('a three-digit total with a failed count fits the bar without clipping', async ({
    page,
  }) => {
    await serve(page, {
      counts: { ...MIXED, pullRequests: { total: 128, failed: 24 } },
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/settings.html');

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(
      header(page, '/pull-requests.html').locator('.nav-total'),
    ).toHaveText('128');
  });

  test('the header stays inside a 768px window', async ({ page }) => {
    await serve(page, { counts: MIXED });
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto('/settings.html');

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

// Every other test here mocks /api/dashboard. This one asks the real server,
// so the shape the nav reads is checked against the shape the server sends.
test.describe('the real server serves what the nav reads (#1315)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('/api/dashboard carries navCounts in the shape the page reads', async ({
    page,
  }) => {
    const res = await page.request.get('/api/dashboard');
    const body = await res.json();

    expect(res.ok()).toBe(true);
    // Every page except Issues counts running and passed (#1439, #1458);
    // Branches also counts those with no pipeline (#1531).
    const checkedPage = {
      total: expect.any(Number),
      running: expect.any(Number),
      failed: expect.any(Number),
      passed: expect.any(Number),
    };
    expect(body.navCounts).toEqual({
      branches: { ...checkedPage, none: expect.any(Number) },
      pullRequests: checkedPage,
      issues: { total: expect.any(Number) },
      releases: checkedPage,
      bots: checkedPage,
    });
  });

  test('a user with nothing tracked sees only the Branches link and no pills', async ({
    page,
  }) => {
    await page.goto('/settings.html');

    await expect(header(page, '/')).toBeVisible();
    await expect(header(page, '/pull-requests.html')).toHaveCount(0);
    await expect(page.locator('.app-nav .nav-pills')).toHaveCount(0);
  });
});

test.describe('nav counts on a phone (#1315)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    await page.setViewportSize({ width: 360, height: 740 });
  });

  test('the tab bar keeps both numbers, above the icon, and every tab fits', async ({
    page,
  }) => {
    await serve(page, { counts: MIXED });
    await page.goto('/settings.html');

    const branches = tab(page, '/');
    await expect(branches.locator('.nav-total')).toHaveText('12');
    await expect(branches.locator('.nav-failed')).toHaveText('3');
    const pills = await branches.locator('.nav-pills').boundingBox();
    const icon = await branches.locator('svg').last().boundingBox();
    expect((pills?.y ?? 0) + (pills?.height ?? 0)).toBeLessThanOrEqual(
      icon?.y ?? 0,
    );

    const bar = await page.locator('.bottom-nav').boundingBox();
    for (const t of await page.locator('.bottom-nav a').all()) {
      const box = await t.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 999) + (box?.width ?? 999)).toBeLessThanOrEqual(
        (bar?.width ?? 0) + 0.5,
      );
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('a tab’s name carries its visible words and both numbers', async ({
    page,
  }) => {
    await serve(page, { counts: MIXED });
    await page.goto('/settings.html');

    await expect(tab(page, '/')).toHaveAccessibleName('12 Branches, 3 failing');
    await expect(tab(page, '/pull-requests.html')).toHaveAccessibleName(
      '27 PRs, 5 failing',
    );
    await expect(tab(page, '/issues.html')).toHaveAccessibleName('9 Issues');
  });

  test('with three digits and a failed count, no pill spills out of its tab', async ({
    page,
  }) => {
    await serve(page, {
      counts: {
        branches: { total: 128, failed: 24 },
        pullRequests: { total: 128, failed: 24 },
        issues: { total: 128 },
        releases: { total: 128, failed: 24 },
        bots: { total: 128, failed: 24 },
      },
    });
    await page.goto('/settings.html');
    await expect(page.locator('.bottom-nav .nav-failed').first()).toBeVisible();

    const spills = await page.$$eval('.bottom-nav a', (links) =>
      links.flatMap((link) => {
        const tab = link.getBoundingClientRect();
        const box = link.querySelector('.nav-pills')?.getBoundingClientRect();
        if (!box) return [];
        return box.left < tab.left - 0.5 || box.right > tab.right + 0.5
          ? [link.getAttribute('href') ?? '']
          : [];
      }),
    );

    expect(spills).toEqual([]);
  });

  test('every failed pill on the tab bar keeps its glyph', async ({ page }) => {
    await serve(page, {
      counts: { ...MIXED, pullRequests: { total: 128, failed: 24 } },
    });
    await page.goto('/settings.html');

    const failed = page.locator('.bottom-nav .nav-failed');
    await expect(failed).toHaveCount(3);
    for (const pill of await failed.all())
      await expect(pill.locator('svg[aria-hidden="true"]')).toHaveCount(1);
  });
});

test.describe('nav counts are accessible (#1315)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

  // One run keeps axe in this journey (a11y rule). The other three scheme by
  // size combinations are asserted, over the same shared nav, by
  // nav-telemetry-pills and nav-branches-pills (#1502).
  test('no axe violations with the pills, including contrast (phone, dark)', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 360, height: 740 });
    await serve(page, { counts: MIXED });
    await page.goto('/settings.html');
    await expect(page.locator('.bottom-nav .nav-failed')).not.toHaveCount(0);

    expect(
      (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
    ).toEqual([]);
  });
});
