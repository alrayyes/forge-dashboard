import { expect, type Page, type Route } from '@playwright/test';
import { choicesOf } from './label-filter-helper';
import { test } from './server-fixture';

// #1427: the Repo, Author and Label choices on the Pull requests page offer
// only what the list being shown has. The board's own filters (a quick pill,
// the CI pills, Auto-merge) narrow that list, so they narrow these
// choices too; picking an author must never leave an empty list.
// https://github.com/alrayyes/forge-dashboard/issues/1427

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

const choices = async (page: Page, id: string) =>
  (await choicesOf(page, id)).filter((text) => !text.startsWith('All'));

const pill = (page: Page, name: string) =>
  page
    .getByRole('group', { name: 'Quick filters' })
    .getByRole('button', { name, exact: true });

test.describe('Repo, Author and Label choices follow the board filters (#1427)', () => {
  test('offer everything the list has while no board filter is on', async ({
    page,
  }) => {
    await open(page);

    expect(await choices(page, 'shared-author-filter')).toEqual([
      'alice',
      'bob',
    ]);
    expect(await choices(page, 'shared-label-filter')).toEqual(['bug', 'docs']);
  });

  test('the Failing CI pill leaves out what only passing pull requests have', async ({
    page,
  }) => {
    await open(page);

    await pill(page, 'Failing CI').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

    expect(await choices(page, 'shared-author-filter')).toEqual(['alice']);
    expect(await choices(page, 'shared-label-filter')).toEqual(['bug']);
    expect(await choices(page, 'shared-repo-filter')).toEqual(['alrayyes/app']);
  });

  test('the Passing CI pill leaves out what its other states have', async ({
    page,
  }) => {
    await open(page);

    await pill(page, 'Passing CI').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

    expect(await choices(page, 'shared-author-filter')).toEqual(['bob']);
    expect(await choices(page, 'shared-label-filter')).toEqual(['docs']);
    expect(await choices(page, 'shared-repo-filter')).toEqual(['alrayyes/lib']);
  });

  test('the Auto-merge filter leaves out what pull requests without it have', async ({
    page,
  }) => {
    await open(page);

    await page.locator('.filter-bar > .am-group [data-am="on"]').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

    expect(await choices(page, 'shared-author-filter')).toEqual(['alice']);
    expect(await choices(page, 'shared-label-filter')).toEqual(['bug']);
  });

  test('clearing the board filter offers everything again', async ({
    page,
  }) => {
    await open(page);

    await pill(page, 'Failing CI').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
    await pill(page, 'All').click();
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

    expect(await choices(page, 'shared-author-filter')).toEqual([
      'alice',
      'bob',
    ]);
  });
});
