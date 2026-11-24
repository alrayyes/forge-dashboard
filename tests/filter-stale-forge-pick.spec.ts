import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { quickPill } from './quick-pills-helper';
import { test } from './server-fixture';

// A saved forge pick the server does not report reads as All in the pills and
// chips, so it has to filter as All too, not hide every row with nothing to
// click.
// https://github.com/alrayyes/forge-dashboard/issues/4167

function pr(number: number, forge: string) {
  return {
    forge,
    repo: `lab/${forge}`,
    number,
    title: `Pull request ${number} on ${forge}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
  };
}

async function open(
  page: Page,
  baseURL: string | undefined,
  saved: string,
  extra: Record<string, string> = {},
) {
  await page.context().addCookies([
    {
      name: 'forge-board-filters',
      value: encodeURIComponent(
        JSON.stringify({
          shared: { forge: saved, ...extra },
          pr: {},
          issue: {},
          view: {},
        }),
      ),
      url: baseURL ?? '',
    },
  ]);
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: [pr(1, 'github'), pr(2, 'forgejo')],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
}

test.describe('a saved forge pick nothing reports (#4167)', () => {
  test('does not hide rows, and the pills and chips agree', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL, 'gitea');
    await expect(page.getByText('Pull request 1 on github')).toBeVisible();
    await expect(page.getByText('Pull request 2 on forgejo')).toBeVisible();
    await expect(quickPill(page, 'All', 'forge')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.filter-chip-label')).toHaveCount(0);
  });

  test('a saved pick for a reported forge still filters', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL, 'forgejo');
    await expect(page.getByText('Pull request 2 on forgejo')).toBeVisible();
    await expect(page.getByText('Pull request 1 on github')).toBeHidden();
    await expect(quickPill(page, 'Forgejo', 'forge')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.filter-chip-label')).toHaveText(
      'Forge Forgejo',
    );
  });
});

test.describe('a saved forge pick nothing reports, elsewhere on the page (#4171)', () => {
  test('keeps Group by forge offered and the saved grouping', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL, 'gitea', { groupBy: 'forge' });
    await expect(page.getByText('Pull request 1 on github')).toBeVisible();
    const group = page.locator('#shared-group-select');
    await expect(group).toHaveValue('forge');
    await expect(group.locator('option[value="forge"]')).not.toHaveAttribute(
      'hidden',
      /.*/,
    );
  });

  test('draws no Clear filters with no chip', async ({ page, baseURL }) => {
    await open(page, baseURL, 'gitea');
    await expect(page.getByText('Pull request 1 on github')).toBeVisible();
    await expect(page.locator('.filter-chip-label')).toHaveCount(0);
    await expect(page.locator('#clear-filters-button')).toBeHidden();
  });

  test('a pick a pill offers still hides the option and resets the grouping', async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL, 'forgejo', { groupBy: 'forge' });
    await expect(page.getByText('Pull request 2 on forgejo')).toBeVisible();
    await expect(page.locator('#shared-group-select')).toHaveValue('');
    await expect(
      page.locator('#shared-group-select option[value="forge"]'),
    ).toBeHidden();
  });
});

test.describe('a saved forge pick nothing reports, on Insights (#4171)', () => {
  test('presses the All pill', async ({ page, baseURL }) => {
    await page.context().addCookies([
      {
        name: 'forge-board-filters',
        value: JSON.stringify({ shared: { forge: 'gitea' } }),
        domain: 'localhost',
        path: '/',
      },
    ]);
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [forgeHealth('github'), forgeHealth('forgejo')],
          pullRequests: [pr(1, 'github'), pr(2, 'forgejo')],
          issues: [],
        }),
      }),
    );
    await page.goto('/insights.html');
    await expect(page.locator('#repo-pr-ranking .rank-row')).not.toHaveCount(0);
    await expect(
      page
        .getByRole('group', { name: 'Forge', exact: true })
        .getByRole('button', { name: 'All', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
