import { expect, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// At 320px with the root font size at 400% the Webhooks hint, with its links
// to Settings, stays inside the viewport and the page doesn't scroll sideways
// (#4028). WCAG 1.4.10 Reflow.
// https://www.w3.org/WAI/WCAG22/Understanding/reflow.html

test('the Webhooks hint wraps inside the viewport at 400% text on 320px', async ({
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
  await page.goto('/webhooks.html');
  await expect(page.locator('#webhooks-hint')).toBeVisible();
  await page.addStyleTag({ content: 'html { font-size: 400% !important; }' });
  const out = await page.evaluate(() => {
    const wide = [
      ...document.querySelectorAll('#webhooks-hint, #webhooks-hint *'),
    ]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > window.innerWidth + 0.5 || r.left < -0.5;
      })
      .map((e) => e.tagName);
    const root = document.documentElement;
    return { wide, scrolls: root.scrollWidth > root.clientWidth };
  });
  expect(out.wide).toEqual([]);
  expect(out.scrolls).toBe(false);
});
