import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { quickPill } from './quick-pills-helper';
import { test } from './server-fixture';

// The Forge pills list the forges the server reports, not a github and
// forgejo pair written into the page, so a third forge gets its own pill with
// its own label, and filters to its own rows.
// https://github.com/alrayyes/forge-dashboard/issues/3978

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
    // Stated, so the mock needs no allowed-actions row for a forge the table
    // has never heard of.
    allowedActions: [],
    status: null,
    kind: 'regular',
  };
}

async function open(page: Page) {
  const gitea = forgeHealth('github', {
    forge: 'gitea',
    capabilities: { ...forgeHealth('github').capabilities, label: 'Gitea' },
  });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo'), gitea],
        pullRequests: [pr(1, 'github'), pr(2, 'forgejo'), pr(3, 'gitea')],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
}

test.describe('a forge the server reports gets a pill (#3978)', () => {
  test('gitea is listed after the shipped forges, labelled, and filters its rows', async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByText('Pull request 3 on gitea')).toBeVisible();

    const pills = page.locator(
      '.filter-bar .quick-pills[data-group="forge"] .quick-pill',
    );
    await expect(pills).toHaveText(['All', 'GitHub', 'Forgejo', 'Gitea']);

    await quickPill(page, 'Gitea', 'forge').click();
    await expect(quickPill(page, 'Gitea', 'forge')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('Pull request 3 on gitea')).toBeVisible();
    await expect(page.getByText('Pull request 1 on github')).toBeHidden();
    await expect(page.getByText('Pull request 2 on forgejo')).toBeHidden();
  });

  test('a saved gitea pick is pressed again after a reload, with its chip', async ({
    page,
  }) => {
    await open(page);
    await quickPill(page, 'Gitea', 'forge').click();
    await expect(page.getByText('Pull request 1 on github')).toBeHidden();

    await page.reload();
    // Gitea is only known once the read reports it, so the pill is drawn after
    // mount and has to pick up the saved state when it arrives.
    await expect(quickPill(page, 'Gitea', 'forge')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.filter-chip-label')).toHaveText('Forge Gitea');
    await expect(page.getByText('Pull request 3 on gitea')).toBeVisible();
  });
});
