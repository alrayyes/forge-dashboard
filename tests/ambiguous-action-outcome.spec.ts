import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { viaActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

// A request that rejects with no status can still have reached the server.
// The row settles on what the server shows now instead of reporting
// "Couldn't reach the server" for an action that ran. A request that truly
// never got through still says so.

const PR = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'A pull request',
  url: 'https://example.com/42',
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'mergeable',
  behind: true,
  kind: 'regular',
};

const snapshot = (prs: object[]) =>
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: prs,
    issues: [],
  });

// `afterAction` is what a forced refresh answers once the action was sent.
async function setup(page: Page, afterAction: () => object[] | null) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot([PR]),
    }),
  );
  await page.route('**/api/dashboard/refresh', (route: Route) => {
    const prs = afterAction();
    if (prs === null) return route.abort('failed');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(prs),
    });
  });
}

const row = (page: Page) => page.locator('#pr-rows .row').first();
const line = (page: Page) => row(page).locator('.row-feedback-line');

async function clickUpdate(page: Page) {
  await viaActionsDialog(row(page), async (footer) => {
    await footer.getByRole('button', { name: 'Update branch' }).click();
  });
}

test.describe('an action request that got no answer', () => {
  test('update branch: a refresh that drops after the server took the request is no failure', async ({
    page,
  }) => {
    await setup(page, () => null);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.goto('/pull-requests.html');
    const refreshed = page.waitForRequest('**/api/dashboard/refresh');
    await clickUpdate(page);
    await refreshed;
    await expect(page.locator('body')).not.toContainText(
      "Couldn't reach the server",
    );
    await expect(line(page)).toHaveCount(0);
  });

  test('update branch: a dropped request the server ran shows no error', async ({
    page,
  }) => {
    await setup(page, () => [{ ...PR, behind: false }]);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    const refreshed = page.waitForRequest('**/api/dashboard/refresh');
    await clickUpdate(page);
    await refreshed;
    await expect(
      row(page).getByRole('button', { name: /Update branch|Queued/ }),
    ).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(
      "Couldn't reach the server",
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('update branch: a request that never got through still says so and can be retried', async ({
    page,
  }) => {
    await setup(page, () => [PR]);
    await page.route('**/api/pull-requests/update-branch', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    await clickUpdate(page);
    await expect(line(page)).toContainText("Couldn't reach the server");
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('close: a dropped request the server ran settles as closed', async ({
    page,
  }) => {
    await setup(page, () => []);
    await page.route('**/api/pull-requests/close', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    const refreshed = page.waitForRequest('**/api/dashboard/refresh');
    await viaActionsDialog(row(page), async (footer) => {
      await footer.getByRole('button', { name: 'Close pull request' }).click();
      await footer
        .getByRole('button', { name: 'Confirm close pull request?' })
        .click();
    });
    await refreshed;
    await expect(page.locator('body')).not.toContainText(
      "Couldn't reach the server",
    );
  });
});
