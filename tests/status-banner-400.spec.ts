import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { rateLimit } from './rate-limit-mock';
import { test } from './server-fixture';

// The status banners at the top of a list page (an unreachable forge with stale
// data, a spent rate limit) stay inside the viewport at 320px and 400% text, so
// the page never scrolls sideways (#4644, found in review of #4643). The error
// banner (a failed read) is measured too, for the ticket's third criterion.
// https://github.com/alrayyes/forge-dashboard/issues/4644
// https://www.w3.org/WAI/WCAG22/Understanding/reflow.html

type Banner = 'unreachable' | 'rate-limit' | 'error';

const SELECTOR: Record<Banner, string> = {
  unreachable: '#unreachable-banner',
  'rate-limit': '#rate-limit-banner',
  error: '#error-banner',
};

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

async function open(
  page: Page,
  banner: Banner,
  width = 1280,
  scheme: 'light' | 'dark' = 'light',
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 800 });
  const health: Record<Banner, Record<string, unknown>> = {
    unreachable: {
      reachable: false,
      errorKind: 'unreachable',
      error: 'dial tcp: i/o timeout',
      staleSince: minutesAgo(26),
    },
    'rate-limit': {
      rateLimitREST: rateLimit(
        5000,
        0,
        new Date(Date.now() + 20 * 60_000).toISOString(),
      ),
      rateLimitGraphQL: rateLimit(
        5000,
        0,
        new Date(Date.now() + 20 * 60_000).toISOString(),
      ),
    },
    error: {},
  };
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) => {
    if (new URL(route.request().url()).pathname !== '/api/v1/dashboard')
      return route.fallback();
    if (banner === 'error')
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"boom"}',
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github', health[banner])],
        pullRequests: [],
        issues: [],
        repos: [{ forge: 'github', fullName: 'acme/web', hasWebhook: true }],
        firstRefreshDone: true,
      }),
    });
  });
  await page.goto('/pull-requests.html');
  await expect(page.locator(SELECTOR[banner])).toBeVisible();
}

const wide = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (!box) return ['missing'];
    return [box, ...box.querySelectorAll('*')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > window.innerWidth + 1 || r.left < -1;
      })
      .map((e) => `${e.tagName}.${e.className}`);
  }, selector);

for (const banner of ['unreachable', 'rate-limit', 'error'] as const) {
  test(`${banner} banner at 320px and 400% text stays inside the viewport`, async ({
    page,
  }) => {
    await open(page, banner, 320);
    await page.addStyleTag({ content: 'html { font-size: 400% }' });
    expect(await wide(page, SELECTOR[banner])).toEqual([]);
    const scrolls = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(scrolls).toBeLessThanOrEqual(0);
  });
}

for (const banner of ['unreachable', 'rate-limit'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      test(`${banner} banner has no axe violations at ${width}px in ${scheme}`, async ({
        page,
      }) => {
        await open(page, banner, width, scheme);
        const { violations } = await new AxeBuilder({ page })
          .include(SELECTOR[banner])
          .analyze();
        expect(violations.map((v) => v.id)).toEqual([]);
      });
    }
  }

  test(`${banner} banner has no axe violations in forced colours`, async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, banner);
    const { violations } = await new AxeBuilder({ page })
      .include(SELECTOR[banner])
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
}
