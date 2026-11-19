import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// While the server says a pull request's check list is incomplete
// (`checksIncomplete`), its pill says "Counting checks…" in place of its state
// word, on a phone too, keeps the counts it has, and carries the same words in
// its accessible name. The server sends the fact; the page words it.
// https://github.com/alrayyes/forge-dashboard/issues/4253

const WORDS = 'Counting checks…';

function pr(number: number, title: string, checksIncomplete: boolean) {
  return {
    forge: 'forgejo',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://git.example/alrayyes/app/pulls/${number}`,
    author: 'claude',
    draft: false,
    ci: 'pending',
    checks: { passed: 1, running: 1, waiting: 2, failed: 0 },
    checksIncomplete,
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (200 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
  };
}

async function openBoard(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('forgejo')],
        pullRequests: [
          pr(1, 'Still counting', true),
          pr(2, 'All listed', false),
        ],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row').first()).toBeVisible();
}

const pill = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title }).locator('.ci-pill');

for (const [name, size] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 800 }],
] as const) {
  test.describe(`an incomplete check list on a ${name}`, () => {
    test.use({ viewport: size });

    test('the words show, the counts stay and the name says it', async ({
      page,
    }) => {
      await openBoard(page);

      const counting = pill(page, 'Still counting');
      await expect(counting.locator('.ci-word')).toBeVisible();
      await expect(counting.locator('.ci-word')).toHaveText(WORDS);
      await expect(counting.locator('.ci-seg:not(.ci-seg-label)')).toHaveText([
        '1',
        '1',
        '2',
      ]);
      await expect(counting).toHaveAttribute(
        'aria-label',
        new RegExp(`^${WORDS} 1 1 2: .*not complete yet\\. Open pipeline$`),
      );
    });

    test('a complete list keeps its state word', async ({ page }) => {
      await openBoard(page);

      await expect(pill(page, 'All listed')).not.toContainText(WORDS);
      await expect(pill(page, 'All listed')).not.toHaveClass(/counting/);
    });

    test('has no axe violations', async ({ page }) => {
      await openBoard(page);

      const results = await new AxeBuilder({ page })
        .include('#pr-rows')
        .analyze();

      expect(results.violations).toEqual([]);
    });
  });
}
