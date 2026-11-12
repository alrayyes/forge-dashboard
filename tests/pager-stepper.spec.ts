import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// #3450: on a phone the pager is Previous, "Page N of M" and Next instead of a
// row of page numbers, and a polite live region announces the new page. The
// shared .pagination-* markup is on the pull request and issue boards and on
// Webhooks. Wide screens keep the row of numbers.
// https://github.com/alrayyes/forge-dashboard/issues/3450

const now = new Date().toISOString();

const prs = Array.from({ length: 60 }, (_, i) => ({
  forge: 'forgejo',
  repo: 'alrayyes/dotfiles',
  number: i + 1,
  title: `Pull request ${i + 1}`,
  url: `https://example.com/pulls/${i + 1}`,
  author: 'ryankes',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: now,
  updatedAt: now,
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
}));

const issues = Array.from({ length: 60 }, (_, i) => ({
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: i + 1,
  title: `Issue ${i + 1}`,
  url: `https://example.com/issues/${i + 1}`,
  author: 'alrayyes',
  labels: [],
  createdAt: now,
  updatedAt: now,
}));

const repos = Array.from({ length: 60 }, (_, i) => ({
  forge: 'github',
  fullName: `alrayyes/repo-${String(i).padStart(2, '0')}`,
  hasWebhook: true,
}));

async function mock(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (r) => r.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: prs,
        issues,
        repos,
        openIssueCount: issues.length,
        navCounts: navCountsFor(prs, issues.length),
      }),
    }),
  );
}

const boards = [
  { name: 'pull requests', path: '/pull-requests.html', id: 'pr-pagination' },
  { name: 'issues', path: '/issues.html', id: 'issue-pagination' },
  { name: 'webhooks', path: '/webhooks.html', id: 'webhooks-pagination' },
];

for (const b of boards) {
  const root = `#${b.id}`;

  test.describe(`${b.name} pager stepper (#3450)`, () => {
    for (const scheme of ['light', 'dark'] as const) {
      test(`390px shows Previous, Page N of M and Next (${scheme})`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width: 390, height: 800 });
        await mock(page);
        await page.goto(b.path);

        const status = page.locator(`${root} .pagination-status`);
        await expect(status).toBeVisible();
        await expect(status).toHaveText('Page 1 of 3');
        await expect(
          page.locator(`${root} .pagination-page`).first(),
        ).toBeHidden();
        await expect(
          page
            .locator(`${root} .pagination-nav`)
            .filter({ hasText: 'Previous' }),
        ).toBeVisible();

        for (const btn of await page.locator(`${root} .pagination-nav`).all()) {
          const box = await btn.boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
        }

        await page
          .locator(`${root} .pagination-nav`)
          .filter({ hasText: 'Next' })
          .click();
        await expect(status).toHaveText('Page 2 of 3');

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }

    for (const width of [360, 320]) {
      test(`${width}px does not scroll sideways`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await mock(page);
        await page.goto(b.path);
        await expect(page.locator(`${root} .pagination-status`)).toBeVisible();
        const [scroll, client] = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ]);
        expect(scroll).toBeLessThanOrEqual(client);
      });
    }

    test('paging announces the new page once and leaves focus alone', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await mock(page);
      await page.goto(b.path);

      const live = page.locator(`${root} [role="status"][aria-live="polite"]`);
      await expect(live).toHaveCount(1);
      await expect(live).toHaveText('');

      // Record every text the region takes, to prove it speaks once per move.
      await live.evaluate((el) => {
        const w = window as unknown as { __said: string[] };
        w.__said = [];
        new MutationObserver(() => {
          if (el.textContent) w.__said.push(el.textContent);
        }).observe(el, { childList: true, characterData: true, subtree: true });
      });

      const next = page
        .locator(`${root} .pagination-nav`)
        .filter({ hasText: 'Next' });
      await next.focus();
      await page.keyboard.press('Enter');
      await expect(live).toHaveText('Page 2 of 3');
      await expect(
        page.locator(`${root} .pagination-nav`).filter({ hasText: 'Next' }),
      ).toBeFocused();
      expect(
        await page.evaluate(
          () => (window as unknown as { __said: string[] }).__said,
        ),
      ).toEqual(['Page 2 of 3']);
    });

    test('761px keeps the row of page numbers', async ({ page }) => {
      await page.setViewportSize({ width: 761, height: 800 });
      await mock(page);
      await page.goto(b.path);
      await expect(page.locator(`${root} .pagination-page`)).toHaveCount(3);
      await expect(
        page.locator(`${root} .pagination-page`).first(),
      ).toBeVisible();
      await expect(page.locator(`${root} .pagination-status`)).toBeHidden();
    });
  });
}
