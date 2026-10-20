import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1427: the Repo, Author and Label choices on the Pull requests page offer
// only what the list being shown has. The board's own filters (a quick pill,
// the CI status select, Auto-merge) narrow that list, so they narrow these
// choices too; picking an author must never leave an empty list.
// https://github.com/alrayyes/forge-dashboard/issues/1427

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `board-choices-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Board Choices');
}

function pr(
  number: number,
  author: string,
  repo: string,
  label: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    forge: 'github',
    repo,
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author,
    draft: false,
    ci: 'success',
    labels: [{ name: label, color: 'ededed' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    ...overrides,
  };
}

// alice's pull request fails CI in alrayyes/app with label "bug" and has
// auto-merge on. bob's passes, in alrayyes/lib with label "docs", with
// auto-merge off.
const PRS = [
  pr(1, 'alice', 'alrayyes/app', 'bug', {
    ci: 'failure',
    autoMergeEnabled: true,
  }),
  pr(2, 'bob', 'alrayyes/lib', 'docs', {
    ci: 'success',
    autoMergeEnabled: false,
  }),
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const choices = (page: Page, id: string) =>
  page
    .locator(`#${id} option`)
    .evaluateAll((os) =>
      os
        .map((o) => (o as HTMLOptionElement).textContent?.trim() ?? '')
        .filter((text) => !text.startsWith('All')),
    );

const pill = (page: Page, name: string) =>
  page
    .getByRole('group', { name: 'Quick filters' })
    .getByRole('button', { name, exact: true });

test.describe('Repo, Author and Label choices follow the board filters (#1427)', () => {
  // Each test sets a filter, which the server saves per user, so each gets
  // its own user.
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('offer everything the list has while no board filter is on', async ({
    page,
  }) => {
    await open(page);

    expect(await choices(page, 'shared-author-select')).toEqual([
      'alice',
      'bob',
    ]);
    expect(await choices(page, 'shared-label-select')).toEqual(['bug', 'docs']);
  });

  test('the Failing CI pill leaves out what only passing pull requests have', async ({
    page,
  }) => {
    await open(page);

    await pill(page, 'Failing CI').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

    expect(await choices(page, 'shared-author-select')).toEqual(['alice']);
    expect(await choices(page, 'shared-label-select')).toEqual(['bug']);
    expect(await choices(page, 'shared-repo-select')).toEqual(['alrayyes/app']);
  });

  test('the CI status filter leaves out what its other states have', async ({
    page,
  }) => {
    await open(page);

    await page.selectOption('select[data-col="status"]', 'success');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

    expect(await choices(page, 'shared-author-select')).toEqual(['bob']);
    expect(await choices(page, 'shared-label-select')).toEqual(['docs']);
    expect(await choices(page, 'shared-repo-select')).toEqual(['alrayyes/lib']);
  });

  test('the Auto-merge filter leaves out what pull requests without it have', async ({
    page,
  }) => {
    await open(page);

    await page.locator('.filter-bar > .am-group [data-am="on"]').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

    expect(await choices(page, 'shared-author-select')).toEqual(['alice']);
    expect(await choices(page, 'shared-label-select')).toEqual(['bug']);
  });

  test('clearing the board filter offers everything again', async ({
    page,
  }) => {
    await open(page);

    await pill(page, 'Failing CI').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await pill(page, 'All').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    expect(await choices(page, 'shared-author-select')).toEqual([
      'alice',
      'bob',
    ]);
  });
});
