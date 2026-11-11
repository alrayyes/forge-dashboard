import type { Page, Route } from '@playwright/test';
import { expect } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// #3290: renderPagination rebuilds every button, so the one the keyboard user
// pressed left the DOM and focus fell to BODY. Next and Previous keep focus,
// and at either end focus lands on the nearest button that remains.

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
        openIssueCount: issues.length,
        navCounts: navCountsFor(prs, issues.length),
      }),
    }),
  );
}

const focus = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? '',
      text: (a?.textContent ?? '').trim(),
      inPager: a?.closest('.pagination') != null,
    };
  });

const boards = [
  { name: 'pull requests', path: '/pull-requests.html', prefix: 'pr' },
  { name: 'issues', path: '/issues.html', prefix: 'issue' },
];

for (const b of boards) {
  test.describe(`${b.name} pagination focus`, () => {
    test.beforeEach(async ({ page }) => {
      await mock(page);
      await page.goto(b.path);
      await expect(
        page.locator(`#${b.prefix}-pagination-pages .pagination-page.active`),
      ).toHaveText('1');
    });

    const nav = (page: Page, name: string) =>
      page
        .locator(`#${b.prefix}-pagination-pages .pagination-nav`)
        .filter({ hasText: name });
    const active = (page: Page) =>
      page.locator(`#${b.prefix}-pagination-pages .pagination-page.active`);

    test('Next keeps focus on the new Next, and Previous steps back', async ({
      page,
    }) => {
      await nav(page, 'Next').focus();
      await page.keyboard.press('Enter');
      await expect(active(page)).toHaveText('2');
      expect(await focus(page)).toMatchObject({ tag: 'BUTTON', text: 'Next' });

      await nav(page, 'Previous').focus();
      await page.keyboard.press('Enter');
      await expect(active(page)).toHaveText('1');
      // Back on page 1 Previous is disabled, so focus moves to Next.
      expect(await focus(page)).toMatchObject({ tag: 'BUTTON', text: 'Next' });
    });

    test('Previous keeps focus while earlier pages remain', async ({
      page,
    }) => {
      await nav(page, 'Next').focus();
      await page.keyboard.press('Enter');
      await expect(active(page)).toHaveText('2');
      await page.keyboard.press('Enter');
      await expect(active(page)).toHaveText('3');
      await nav(page, 'Previous').focus();
      await page.keyboard.press('Enter');
      await expect(active(page)).toHaveText('2');
      expect(await focus(page)).toMatchObject({
        tag: 'BUTTON',
        text: 'Previous',
      });
    });

    test('Next on the last page lands on Previous, never BODY', async ({
      page,
    }) => {
      await nav(page, 'Next').focus();
      await page.keyboard.press('Enter');
      await expect(active(page)).toHaveText('2');
      await page.keyboard.press('Enter');
      await expect(active(page)).toHaveText('3');
      const f = await focus(page);
      expect(f.tag).not.toBe('BODY');
      expect(f.inPager).toBe(true);
      expect(f.text).toBe('Previous');
    });

    test('a page number keeps focus on that page number', async ({ page }) => {
      await page
        .locator(`#${b.prefix}-pagination-pages .pagination-page`)
        .filter({ hasText: /^2$/ })
        .focus();
      await page.keyboard.press('Enter');
      await expect(active(page)).toHaveText('2');
      expect(await focus(page)).toMatchObject({ tag: 'BUTTON', text: '2' });
    });
  });
}

// #3400: a size that fits every row on one page used to hide the whole pager,
// select included, so focus fell to BODY and the person couldn't go back.
for (const b of boards) {
  test(`${b.name} page size select stays visible and focused on one page`, async ({
    page,
  }) => {
    await mock(page);
    await page.goto(b.path);
    const buttons = page.locator(
      `#${b.prefix}-pagination-pages .pagination-page`,
    );
    await expect(buttons).toHaveCount(3);

    const size = page.locator(`#${b.prefix}-page-size`);
    await size.focus();
    await size.selectOption('100');
    await expect(size).toBeVisible();
    await expect(buttons).toHaveCount(0);
    await expect(size).toBeFocused();

    await size.selectOption('25');
    await expect(buttons).toHaveCount(3);
    await expect(size).toBeFocused();
  });
}
