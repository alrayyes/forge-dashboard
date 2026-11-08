import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3209
//
// On a phone (420px and under) the bottom nav is fixed over the viewport's
// last 46px. Tab scrolls a control below the fold in only until it is flush
// with the viewport bottom, which put it under the nav. `scroll-padding-bottom`
// on the root keeps it clear (WCAG 2.2 SC 2.4.11 Focus Not Obscured).

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const pullRequests = Array.from({ length: 25 }, (_, i) => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: i + 1,
  title: `Change number ${i + 1} with a reasonably long title that wraps`,
  url: `https://example.com/pulls/${i + 1}`,
  author: 'ryankes',
  draft: false,
  ci: i % 2 ? 'failure' : 'success',
  labels: [{ name: 'bug', color: 'd73a4a' }],
  createdAt: ago(60 + i),
  updatedAt: ago(i),
  mergeStatus: 'mergeable',
  behind: false,
}));

const issues = Array.from({ length: 25 }, (_, i) => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: i + 1,
  title: `Issue ${i + 1}`,
  url: `https://example.com/issues/${i + 1}`,
  author: 'alrayyes',
  labels: [{ name: 'bug', color: 'd73a4a' }],
  createdAt: ago(100 + i),
  updatedAt: ago(i),
}));

const repos = Array.from({ length: 14 }, (_, i) => ({
  forge: 'github',
  fullName: `alrayyes/repo-${i}`,
  hasWebhook: i % 2 === 0,
  canManageWebhooks: true,
}));

async function mock(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 14 }],
        pullRequests,
        issues,
        repos,
        hiddenDrafts: 0,
      }),
    }),
  );
}

const PAGES = [
  ['/pull-requests.html', '.row'],
  ['/issues.html', '.row'],
  ['/webhooks.html', '#webhooks-table tbody tr'],
] as const;

test.describe('focus clears the bottom nav at 390px', () => {
  for (const [path, ready] of PAGES) {
    test(`tabbing through ${path}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await mock(page);
      await page.goto(path);
      await expect(page.locator(ready).first()).toBeVisible();
      await expect(page.locator('.bottom-nav')).toBeVisible();

      const overlaps: string[] = [];
      await page.evaluate(() => window.scrollTo(0, 0));
      for (let i = 0; i < 150; i++) {
        await page.keyboard.press('Tab');
        const hit = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          if (el.closest('.bottom-nav')) return 'nav';
          const nav = document.querySelector('.bottom-nav');
          if (!nav) return null;
          const r = el.getBoundingClientRect();
          const n = nav.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return r.bottom > n.top && r.top < n.bottom
            ? `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 24)}" bottom ${Math.round(r.bottom)} > nav top ${Math.round(n.top)}`
            : null;
        });
        if (hit === 'nav') continue;
        if (hit) overlaps.push(`stop ${i + 1}: ${hit}`);
      }
      expect(overlaps, `\n${overlaps.join('\n')}\n`).toEqual([]);
    });
  }
});
