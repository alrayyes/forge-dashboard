import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// At 320px with the root font size at 400% the Branches page header (the h1
// and the live control's time) stays inside the viewport and the page doesn't
// scroll sideways (#4631). WCAG 1.4.10 Reflow.
// https://github.com/alrayyes/forge-dashboard/issues/4631
// https://www.w3.org/WAI/WCAG22/Understanding/reflow.html

async function open(page: Page) {
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
  await page.addStyleTag({ content: 'html { font-size: 400% }' });
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
