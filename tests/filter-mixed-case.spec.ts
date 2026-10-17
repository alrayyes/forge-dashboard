import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1620: an author or label with capitals ("Ryan", "Bug") is saved lowercase,
// and used to be cleared the moment it was picked because the rebuilt select
// compared exactly. The pick must stay, shown as written, and survive leaving
// the page and coming back. The saved state is per user, so this spec
// registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/1620

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'Ryan',
    labels: [{ name: 'Bug', color: 'd73a4a' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const ISSUES = [
  issue(1),
  issue(2, { author: 'sam', labels: [{ name: 'docs', color: '0366d6' }] }),
  issue(3, { author: 'Ryan', labels: [] }),
];

async function open(page: Page, url: string) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(url);
}

const issueRows = (page: Page) => page.locator('#issue-rows > .row');

test.describe('a pick with capitals stays picked (#1620)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `filter-mixed-case-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Filter Mixed Case',
    );
    await open(page, '/issues.html');
    await expect(issueRows(page)).toHaveCount(3);
  });

  for (const [control, select, value, kept] of [
    ['author', '#shared-author-select', 'Ryan', 2],
    ['label', '#shared-label-select', 'Bug', 1],
  ] as const) {
    test(`the ${control} pick ${value} is kept, and is still set after a full load`, async ({
      page,
    }) => {
      await page.locator(select).selectOption(value);
      await expect(issueRows(page)).toHaveCount(kept);
      // The page rebuilds its choices after a pick; the pick must outlast that.
      await expect(page.locator(select)).toHaveValue(value);
      await expect(page.locator(`${select} option:checked`)).toHaveText(value);

      await open(page, '/issues.html');
      await expect(page.locator(select)).toHaveValue(value);
      await expect(issueRows(page)).toHaveCount(kept);
    });
  }
});
