import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1439: the Pull requests, Bots and Releases items show the total and how
// many pull requests are failing, running and passing, as one pill: a neutral
// total, then the non-zero counts, each with its own glyph. Zero is never
// drawn. The server counts them (`navCounts`); the page only draws them.
// https://github.com/alrayyes/forge-dashboard/issues/1439

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `nav-telemetry-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Nav Telemetry');
}

type Counts = {
  total: number;
  running: number;
  failed: number;
  passed: number;
};

const MIXED: Counts = { total: 15, running: 3, failed: 2, passed: 10 };
const NONE: Counts = { total: 0, running: 0, failed: 0, passed: 0 };

async function open(
  page: Page,
  counts: {
    pullRequests?: Counts;
    releases?: Counts;
    bots?: Counts;
  } = {},
  path = '/settings.html',
) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        openIssueCount: 4,
        repos: [],
        hiddenDrafts: 0,
        navCounts: {
          branches: { total: 3, failed: 0 },
          pullRequests: counts.pullRequests ?? MIXED,
          issues: { total: 4 },
          releases: counts.releases ?? NONE,
          bots: counts.bots ?? NONE,
        },
      }),
    }),
  );
  await page.goto(path);
}

const header = (page: Page, href: string) =>
  page.locator(`header nav a[href="${href}"]`);
const tab = (page: Page, href: string) =>
  page.locator(`.bottom-nav a[href="${href}"]`);
const PRS = '/pull-requests.html';

test.describe('the nav pill shows failing, running and passing (#1439)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('Pull requests shows the total, then failed, running and passed, each with its glyph', async ({
    page,
  }) => {
    await open(page);
    const pill = header(page, PRS).locator('.nav-pills');

    await expect(pill.locator('.nav-total')).toHaveText('15');
    await expect(pill.locator('.nav-failed')).toHaveText('2');
    await expect(pill.locator('.nav-running')).toHaveText('3');
    await expect(pill.locator('.nav-passed')).toHaveText('10');
    // Every count has its own glyph, so colour is never the only signal.
    for (const kind of ['failed', 'running', 'passed']) {
      await expect(pill.locator(`.nav-${kind} svg`).first()).toBeAttached();
    }
    // The order is the triage order: failed, then running, then passed.
    const order = await pill.evaluate((el) =>
      [...el.children].map(
        (c) => c.className.split(' ').find((n) => n !== 'nav-count') ?? '',
      ),
    );
    expect(order).toEqual([
      'nav-total',
      'nav-failed',
      'nav-running',
      'nav-passed',
    ]);
  });

  test('the link says it in words, in the same order, and the pills stay hidden from a screen reader', async ({
    page,
  }) => {
    await open(page);

    await expect(header(page, PRS)).toHaveAttribute(
      'aria-label',
      'Pull requests, 15 total, 2 failing, 3 running, 10 passing',
    );
    await expect(tab(page, PRS)).toHaveAttribute(
      'aria-label',
      '15 PRs, 2 failing, 3 running, 10 passing',
    );
    await expect(header(page, PRS).locator('.nav-pills')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  test('a count of zero is not drawn', async ({ page }) => {
    await open(page, {
      pullRequests: { total: 8, running: 0, failed: 0, passed: 8 },
      releases: { total: 6, running: 6, failed: 0, passed: 0 },
      bots: { total: 4, running: 0, failed: 1, passed: 0 },
    });

    const prs = header(page, PRS).locator('.nav-pills');
    await expect(prs.locator('.nav-passed')).toHaveText('8');
    await expect(prs.locator('.nav-failed')).toHaveCount(0);
    await expect(prs.locator('.nav-running')).toHaveCount(0);
    await expect(header(page, PRS)).toHaveAttribute(
      'aria-label',
      'Pull requests, 8 total, 8 passing',
    );
    await expect(header(page, '/releases.html')).toHaveAttribute(
      'aria-label',
      'Releases, 6 total, 6 running',
    );
    await expect(header(page, '/bots.html')).toHaveAttribute(
      'aria-label',
      'Bots, 4 total, 1 failing',
    );
  });

  test('Bots and Releases show the same pill for their own counts', async ({
    page,
  }) => {
    await open(page, {
      releases: { total: 6, running: 6, failed: 0, passed: 0 },
      bots: MIXED,
    });

    const bots = header(page, '/bots.html').locator('.nav-pills');
    await expect(bots.locator('.nav-total')).toHaveText('15');
    await expect(bots.locator('.nav-failed')).toHaveText('2');
    await expect(bots.locator('.nav-running')).toHaveText('3');
    await expect(bots.locator('.nav-passed')).toHaveText('10');
    const releases = header(page, '/releases.html').locator('.nav-pills');
    await expect(releases.locator('.nav-total')).toHaveText('6');
    await expect(releases.locator('.nav-running')).toHaveText('6');
    await expect(releases.locator('.nav-failed')).toHaveCount(0);
  });

  test('large numbers are shown whole and named whole', async ({ page }) => {
    await open(page, {
      pullRequests: { total: 1204, running: 85, failed: 18, passed: 1100 },
    });

    await expect(header(page, PRS).locator('.nav-total')).toHaveText('1204');
    await expect(header(page, PRS).locator('.nav-passed')).toHaveText('1100');
    await expect(header(page, PRS)).toHaveAttribute(
      'aria-label',
      'Pull requests, 1204 total, 18 failing, 85 running, 1100 passing',
    );
  });

  test('a page with nothing in it shows no pill', async ({ page }) => {
    await open(page, { pullRequests: NONE });

    await expect(header(page, PRS).locator('.nav-pills')).toHaveCount(0);
  });

  test('under reduced motion the running glyph is still, and otherwise it spins', async ({
    page,
  }) => {
    await open(page);
    const spin = header(page, PRS).locator('.nav-running .glyph-spin');
    const clock = header(page, PRS).locator('.nav-running .glyph-clock');
    await expect(spin).toBeVisible();
    await expect(clock).toBeHidden();

    await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect(spin).toBeHidden();
    await expect(clock).toBeVisible();
  });

  test('on a 360px phone every tab still fits, and the pill stays inside its tab', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, { bots: MIXED });

    const links = page.locator('.bottom-nav .bottom-nav-link');
    const boxes = await links.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const pill = el.querySelector('.nav-pills')?.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          height: r.height,
          pillLeft: pill?.left ?? null,
          pillRight: pill?.right ?? null,
        };
      }),
    );
    for (const b of boxes) {
      expect(b.right).toBeLessThanOrEqual(360 + 1);
      expect(b.height).toBeGreaterThanOrEqual(44);
      if (b.pillLeft !== null && b.pillRight !== null) {
        expect(b.pillLeft).toBeGreaterThanOrEqual(b.left - 1);
        expect(b.pillRight).toBeLessThanOrEqual(b.right + 1);
      }
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe-core violations in the ${scheme} theme, on desktop and on a phone`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, {
        releases: { total: 6, running: 6, failed: 0, passed: 0 },
        bots: MIXED,
      });

      for (const size of [
        { width: 1280, height: 800 },
        { width: 360, height: 740 },
      ]) {
        await page.setViewportSize(size);
        await expect(header(page, PRS).locator('.nav-pills')).toHaveCount(1);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  }
});
