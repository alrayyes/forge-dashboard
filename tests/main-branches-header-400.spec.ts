import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// At 320px with the root font size at 400% the Branches page header (the h1
// and the live control's time) stays inside the viewport and the page doesn't
// scroll sideways (#4631). WCAG 1.4.10 Reflow.
// https://github.com/alrayyes/forge-dashboard/issues/4631
// https://www.w3.org/WAI/WCAG22/Understanding/reflow.html

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function open(page: Page, width = 320, percent = 400) {
  await page.setViewportSize({ width, height: 800 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [],
        issues: [],
        repos: [{ forge: 'github', fullName: 'acme/a', hasWebhook: true }],
        firstRefreshDone: true,
      }),
    }),
  );
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {},
        branches: [
          {
            forge: 'github',
            fullName: 'acme/a',
            url: 'https://example.com/acme/a',
            branch: 'main',
            status: 'passed',
            commit: {
              sha: 'd98f3c2',
              subject: 'fix: a change',
              author: 'dev',
              committedAt: new Date().toISOString(),
            },
            failingJobs: [],
            finishedAt: new Date().toISOString(),
            durationSeconds: 60,
            runUrl: 'https://example.com/acme/a/actions/runs/1',
            staleSince: null,
          },
        ],
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('.mb-header h1')).toBeVisible();
  if (percent !== 100)
    await page.addStyleTag({ content: `html { font-size: ${percent}% }` });
}

test('at 400% text the header stays inside the viewport', async ({ page }) => {
  await open(page);
  await expect(page.locator('.mb-header .live-updated')).toBeVisible();
  const out = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('.mb-header, .mb-header *')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > window.innerWidth + 0.5 || r.left < -0.5;
      })
      .map((e) => `${e.tagName}.${e.className}`);
    const root = document.documentElement;
    return { wide, scrolls: root.scrollWidth > root.clientWidth };
  });
  expect(out.wide).toEqual([]);
  expect(out.scrolls).toBe(false);
});

// Axe clean at the three widths in light, dark and forced colours; the
// narrowest also at 400%, where the header used to overflow.
for (const mode of ['light', 'dark', 'forced'] as const) {
  for (const width of [1280, 390, 320]) {
    test(`the header has no axe violations at ${width}px in ${mode}`, async ({
      page,
    }) => {
      if (mode === 'forced')
        await page.emulateMedia({ forcedColors: 'active' });
      else await page.emulateMedia({ colorScheme: mode });
      await open(page, width, width === 320 ? 400 : 100);
      const { violations } = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .include('.mb-header')
        .analyze();
      expect(violations.map((v) => v.id)).toEqual([]);
      const root = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(root).toBe(false);
    });
  }
}

// The other boards' live control sits in .board-head-controls (criterion 3 of
// #4631): measured the same way at 320px and 400%.
for (const path of [
  '/pull-requests.html',
  '/issues.html',
  '/releases.html',
  '/bots.html',
]) {
  test(`${path}: the board header stays inside the viewport at 400% text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [forgeHealth('github')],
          pullRequests: [],
          issues: [],
          repos: [{ forge: 'github', fullName: 'acme/a', hasWebhook: true }],
          firstRefreshDone: true,
        }),
      }),
    );
    await page.goto(path);
    await expect(page.locator('.board-head .live-updated')).toBeVisible();
    await page.addStyleTag({ content: 'html { font-size: 400% }' });
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('.board-head, .board-head *')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.right > window.innerWidth + 0.5 || r.left < -0.5;
        })
        .map((e) => `${e.tagName}.${e.className}`),
    );
    expect(wide).toEqual([]);
  });
}
