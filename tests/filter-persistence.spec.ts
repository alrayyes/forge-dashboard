import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import {
  pickedLabels,
  pickedValues,
  pickOnly,
  toggleLabels,
} from './label-filter-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// #1620: a filter set on one page is still set when you come back to it. The
// shared bar's repo, author and label choices are built from the page's own
// items (#1071), so a pick that the page you pass through does not offer used
// to be cleared there and saved as cleared. The saved state is on the server; the
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
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github', { repoCount: 3 })],
        pullRequests: PRS,
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        navCounts: navCountsFor(PRS, ISSUES.length),
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(url);
}

const issueRows = (page: Page) => page.locator('#issue-rows > .row');
const prRows = (page: Page) => page.locator('#pr-rows > .row');
// The nav links load a new document. A read taken before it has replaced the
// old one is either thrown away half way or answered by the page being left,
// so wait for the new page first (#5062).
async function visit(page: Page, name: string) {
  await page.locator(`.app-nav a[href="/${name}.html"]`).click();
  await page.waitForURL((url) => url.pathname === `/${name}.html`);
}

test.describe('picks survive a visit to a page that does not offer them (#1620)', () => {
  test.beforeEach(async ({ page }) => {
    await open(page, '/issues.html');
    await expect(issueRows(page)).toHaveCount(3);
  });

  for (const [control, value, kept] of [
    ['author', 'github:ryan', 2],
    ['repo', 'github:acme/docs', 1],
  ] as const) {
    test(`the ${control} pick on Issues is still set after a client navigation through Pull requests`, async ({
      page,
    }) => {
      await pickOnly(page, control, value);
      await expect(issueRows(page)).toHaveCount(kept);

      await visit(page, 'pull-requests');
      // The pick is not on offer here, so this page shows its whole list.
      await expect(prRows(page)).toHaveCount(2);
      await visit(page, 'issues');

      await expect(issueRows(page)).toHaveCount(kept);
      await expect.poll(() => pickedValues(page, control)).toEqual([value]);
    });

    test(`the ${control} pick on Issues is still set after a full load of Pull requests`, async ({
      page,
    }) => {
      await pickOnly(page, control, value);
      await expect(issueRows(page)).toHaveCount(kept);

      await open(page, '/pull-requests.html');
      await expect(prRows(page)).toHaveCount(2);
      await open(page, '/issues.html');

      await expect(issueRows(page)).toHaveCount(kept);
      await expect.poll(() => pickedValues(page, control)).toEqual([value]);
    });
  }

  test('the label pick on Issues is still set after a client navigation through Pull requests', async ({
    page,
  }) => {
    await toggleLabels(page, 'bug');
    await expect(issueRows(page)).toHaveCount(1);

    await visit(page, 'pull-requests');
    await expect(prRows(page)).toHaveCount(2);
    await visit(page, 'issues');

    await expect(issueRows(page)).toHaveCount(1);
    expect(await pickedLabels(page)).toEqual(['bug']);
  });

  test('the label pick on Issues is still set after a full load of Pull requests', async ({
    page,
  }) => {
    await toggleLabels(page, 'bug');
    await expect(issueRows(page)).toHaveCount(1);

    await open(page, '/pull-requests.html');
    await expect(prRows(page)).toHaveCount(2);
    await open(page, '/issues.html');

    await expect(issueRows(page)).toHaveCount(1);
    expect(await pickedLabels(page)).toEqual(['bug']);
  });

  test('the same pick follows the account to a second browser after the detour', async ({
    page,
  }) => {
    await pickOnly(page, 'author', 'github:ryan');
    await visit(page, 'pull-requests');
    await expect(prRows(page)).toHaveCount(2);

    await expect
      .poll(async () => {
        const res = await page.request.get('/api/v1/settings/filter-state');
        return (await res.json()).shared.author;
      })
      .toBe('github:ryan');
  });

  test('a pick changed on the page that does not offer the old one replaces it', async ({
    page,
  }) => {
    await pickOnly(page, 'author', 'github:ryan');
    await visit(page, 'pull-requests');
    await expect(prRows(page)).toHaveCount(2);
    await pickOnly(page, 'author', 'github:claude');
    await expect(prRows(page)).toHaveCount(1);

    await visit(page, 'issues');
    // claude wrote no issue, so the list is whole and the old pick is gone.
    await expect(issueRows(page)).toHaveCount(3);
    await visit(page, 'pull-requests');
    await expect(prRows(page)).toHaveCount(1);
    await expect
      .poll(() => pickedValues(page, 'author'))
      .toEqual(['github:claude']);
  });

  test('clearing the held author on the other page forgets it', async ({
    page,
  }) => {
    await pickOnly(page, 'author', 'github:ryan');
    await visit(page, 'pull-requests');
    await expect(prRows(page)).toHaveCount(2);
    // Nothing is ticked here, so the held pick is cleared from its note.
    await page
      .getByRole('button', { name: 'Clear saved author "ryan"' })
      .click();
    await visit(page, 'issues');

    await expect(issueRows(page)).toHaveCount(3);
    await expect.poll(() => pickedValues(page, 'author')).toEqual([]);
  });
});
