import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { clearPicks, togglePicks } from './label-filter-helper';
import { test } from './server-fixture';

// #3496: a Repository, Author or Label filter that offers one value, with
// nothing picked, can't narrow the list, so it leaves the bar. A pick keeps it.
// https://github.com/alrayyes/forge-dashboard/issues/3496

const ago = (hours: number) =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

function row(number: number, repo: string, author: string) {
  return {
    forge: 'github',
    repo,
    number,
    title: `Row ${number}`,
    url: `https://example.com/${repo}/${number}`,
    author,
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: ago(48),
    updatedAt: ago(48),
    mergeStatus: 'mergeable',
    allowedActions: [{ action: 'merge' }, { action: 'close' }],
  };
}

async function open(
  page: Page,
  path: string,
  pullRequests: unknown[],
  issues: unknown[] = [],
) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests,
        issues,
        openIssueCount: issues.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
}

const repoFilter = (page: Page) => page.locator('#shared-repo-filter').first();
const authorFilter = (page: Page) =>
  page.locator('#shared-author-filter').first();

const TWO_REPOS = [
  row(1, 'alrayyes/a', 'ann'),
  row(2, 'alrayyes/b', 'bob'),
  row(3, 'alrayyes/a', 'bob'),
];

test.describe('a filter with one option leaves the bar (#3496)', () => {
  test('hides with one repository, shows with two', async ({ page }) => {
    await open(page, '/pull-requests.html', [row(1, 'alrayyes/a', 'ann')]);
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await expect(repoFilter(page)).toBeHidden();
    // One author alike.
    await expect(authorFilter(page)).toBeHidden();

    await page.unrouteAll();
    await open(page, '/pull-requests.html', TWO_REPOS);
    await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
    await expect(repoFilter(page)).toBeVisible();
    await expect(authorFilter(page)).toBeVisible();
  });

  test('keeps a picked single option, and hands focus on when it goes', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html', TWO_REPOS);
    await togglePicks(page, 'repo', 'github:alrayyes/a');
    // Ann is only in repo a, so Repository now offers a alone.
    await togglePicks(page, 'author', 'github:ann');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await expect(repoFilter(page)).toBeVisible();

    // Clearing the pick leaves one option and nothing picked: it hides, and
    // focus lands on a control still in the bar.
    await clearPicks(page, 'repo');
    await expect(repoFilter(page)).toBeHidden();
    const focus = await page.evaluate(
      () => document.activeElement?.tagName ?? '',
    );
    expect(focus).not.toBe('BODY');
  });

  test('applies on the Issues board too', async ({ page }) => {
    await open(page, '/issues.html', [], [row(1, 'alrayyes/a', 'ann')]);
    await expect(page.locator('#issue-rows > .row')).toHaveCount(1);
    await expect(repoFilter(page)).toBeHidden();
  });

  for (const width of [390, 320]) {
    test(`fits at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, '/pull-requests.html', [row(1, 'alrayyes/a', 'ann')]);
      await expect(repoFilter(page)).toBeHidden();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test(`passes axe in both themes`, async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(`${scheme}`, async () => {
        await page.emulateMedia({ colorScheme: scheme });
        await open(page, '/pull-requests.html', [row(1, 'alrayyes/a', 'ann')]);
        await expect(repoFilter(page)).toBeHidden();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
});
