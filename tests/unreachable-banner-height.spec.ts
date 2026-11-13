import AxeBuilder from '@axe-core/playwright';
import { expect, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3802: on a phone the banner is as tall as its message plus its two
// controls, with no empty block between them.

const down = {
  forge: 'github',
  reachable: false,
  repoCount: 1,
  errorKind: 'unreachable',
  error: 'dial tcp: i/o timeout',
  staleSince: new Date(Date.now() - 26 * 60_000).toISOString(),
};

for (const scheme of ['dark', 'light'] as const) {
  for (const width of [360, 390, 1280]) {
    test(`the banner has no empty gap at ${width}px, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      await page.clock.install({ time: new Date() });
      await page.route('**/api/v1/dashboard*', (route: Route) => {
        if (route.request().url().includes('/stream')) return route.abort();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [down],
            pullRequests: [],
            issues: [],
          }),
        });
      });
      await page.goto('/pull-requests.html');
      const banner = page.locator('#unreachable-banner');
      await expect(banner).toContainText('26m ago');

      const box = async (sel: string) => {
        const b = await banner.locator(sel).first().boundingBox();
        if (!b) throw new Error(`${sel} not rendered`);
        return b;
      };
      const bannerBox = (await banner.boundingBox())!;
      const text = await box('.unreachable-banner-text');
      const status = await box('.unreachable-banner-link');
      const retry = await box('.unreachable-banner-retry:not(a)');
      expect(status.height).toBeGreaterThanOrEqual(44);
      expect(retry.height).toBeGreaterThanOrEqual(44);

      // Content height: stacked on a phone, side by side on a desktop.
      const stacked = width <= 480;
      // The message is as tall as the lines it holds, not a flex-basis.
      const lines = await banner
        .locator('.unreachable-banner-text')
        .evaluate((el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return r.getBoundingClientRect().height;
        });
      expect(text.height).toBeLessThanOrEqual(lines + 2);
      const content = stacked
        ? text.height + status.height + retry.height + 2 * 12
        : Math.max(text.height, status.height, retry.height);
      // Padding 12 + 12, borders 2, row gap(s) with a small tolerance.
      expect(bannerBox.height).toBeLessThanOrEqual(content + 24 + 2 + 8);

      // Message and both controls are in view together.
      expect(retry.y + retry.height).toBeLessThanOrEqual(800);

      // The age ticking does not move the banner.
      const before = bannerBox.height;
      await page.clock.fastForward(61_000);
      await expect(banner).toContainText('27m ago');
      expect((await banner.boundingBox())!.height).toBe(before);

      const results = await new AxeBuilder({ page })
        .include('#unreachable-banner')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
