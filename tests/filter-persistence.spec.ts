import { expect, type Page, type Route } from '@playwright/test';
import { pickedLabels, toggleLabels } from './label-filter-helper';
import { test } from './server-fixture';

// #1620: a filter set on one page is still set when you come back to it. The
// shared bar's repo, author and label choices are built from the page's own
// items (#1071), so a pick that the page you pass through does not offer used
// to be cleared there and saved as cleared. The saved state is per user; the
// server fixture resets it between tests.
// https://github.com/alrayyes/forge-dashboard/issues/1620

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [{ name: 'chore', color: '0e8a16' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    ...overrides,
  };
}

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'ryan',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Authors, labels and repos that only one page has: ryan, bug and acme/docs
// are on Issues only; claude, chore and acme/infra on Pull requests only (the
// bot's pull request belongs to the Bots page).
const PRS = [
  pr(1),
  pr(2, { repo: 'acme/infra', author: 'dana', title: 'Pull request two' }),
  pr(3, { author: 'renovate[bot]', labels: [] }),
];
const ISSUES = [
  issue(1),
  issue(2, {
    repo: 'acme/docs',
    author: 'sam',
    labels: [{ name: 'docs', color: '0366d6' }],
  }),
  issue(3, { author: 'ryan', labels: [] }),
];

async function open(page: Page, url: string) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 3 }],
        pullRequests: PRS,
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
const prRows = (page: Page) => page.locator('#pr-rows > .row');
const nav = (page: Page, name: string) =>
  page.locator(`.app-nav a[href="/${name}.html"]`);

test.describe('picks survive a visit to a page that does not offer them (#1620)', () => {
  test.beforeEach(async ({ page }) => {
    await open(page, '/issues.html');
    await expect(issueRows(page)).toHaveCount(3);
  });

  for (const [control, select, value, kept] of [
    ['author', '#shared-author-select', 'ryan', 2],
    ['repo', '#shared-repo-select', 'github:acme/docs', 1],
  ] as const) {
    test(`the ${control} pick on Issues is still set after a client navigation through Pull requests`, async ({
      page,
    }) => {
      await page.locator(select).selectOption(value);
      await expect(issueRows(page)).toHaveCount(kept);

      await nav(page, 'pull-requests').click();
      // The pick is not on offer here, so this page shows its whole list.
      await expect(prRows(page)).toHaveCount(2);
      await nav(page, 'issues').click();

      await expect(page.locator(select)).toHaveValue(value);
      await expect(issueRows(page)).toHaveCount(kept);
    });

    test(`the ${control} pick on Issues is still set after a full load of Pull requests`, async ({
      page,
    }) => {
      await page.locator(select).selectOption(value);
      await expect(issueRows(page)).toHaveCount(kept);

      await open(page, '/pull-requests.html');
      await expect(prRows(page)).toHaveCount(2);
      await open(page, '/issues.html');

      await expect(page.locator(select)).toHaveValue(value);
      await expect(issueRows(page)).toHaveCount(kept);
    });
  }

  test('the label pick on Issues is still set after a client navigation through Pull requests', async ({
    page,
  }) => {
    await toggleLabels(page, 'bug');
    await expect(issueRows(page)).toHaveCount(1);

    await nav(page, 'pull-requests').click();
    await expect(prRows(page)).toHaveCount(2);
    await nav(page, 'issues').click();

    expect(await pickedLabels(page)).toEqual(['bug']);
    await expect(issueRows(page)).toHaveCount(1);
  });

  test('the label pick on Issues is still set after a full load of Pull requests', async ({
    page,
  }) => {
    await toggleLabels(page, 'bug');
    await expect(issueRows(page)).toHaveCount(1);

    await open(page, '/pull-requests.html');
    await expect(prRows(page)).toHaveCount(2);
    await open(page, '/issues.html');

    expect(await pickedLabels(page)).toEqual(['bug']);
    await expect(issueRows(page)).toHaveCount(1);
  });

  test('the same pick follows the account to a second browser after the detour', async ({
    page,
  }) => {
    await page.locator('#shared-author-select').selectOption('ryan');
    await nav(page, 'pull-requests').click();
    await expect(prRows(page)).toHaveCount(2);

    const saved = await (
      await page.request.get('/api/settings/filter-state')
    ).json();
    expect(saved.shared.author).toBe('ryan');
  });

  test('a pick changed on the page that does not offer the old one replaces it', async ({
    page,
  }) => {
    await page.locator('#shared-author-select').selectOption('ryan');
    await nav(page, 'pull-requests').click();
    await expect(prRows(page)).toHaveCount(2);
    await page.locator('#shared-author-select').selectOption('claude');
    await expect(prRows(page)).toHaveCount(1);

    await nav(page, 'issues').click();
    // claude wrote no issue, so the list is whole and the old pick is gone.
    await expect(issueRows(page)).toHaveCount(3);
    await nav(page, 'pull-requests').click();
    await expect(page.locator('#shared-author-select')).toHaveValue('claude');
  });

  test('choosing All authors on the other page forgets the held pick', async ({
    page,
  }) => {
    await page.locator('#shared-author-select').selectOption('ryan');
    await nav(page, 'pull-requests').click();
    await expect(prRows(page)).toHaveCount(2);
    await page.locator('#shared-author-select').selectOption('');
    await nav(page, 'issues').click();

    await expect(page.locator('#shared-author-select')).toHaveValue('');
    await expect(issueRows(page)).toHaveCount(3);
  });
});
