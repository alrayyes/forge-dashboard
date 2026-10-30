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

// Auto-merge is offered while checks are still running.
const WAITING = { ...PR, ci: 'pending', mergeStatus: 'blocked', behind: false };

const snapshot = (prs: object[]) =>
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: prs,
    issues: [],
  });

// `afterAction` is what a forced refresh answers once the action was sent.
async function setup(
  page: Page,
  afterAction: () => object[] | null,
  initial: object = PR,
) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot([initial]),
    }),
  );
  await page.route('**/api/v1/dashboard/refresh', (route: Route) => {
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

async function clickAction(page: Page, name: string) {
  await viaActionsDialog(row(page), async (footer) => {
    await footer.getByRole('button', { name }).click();
  });
}

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
    await page.route('**/api/v1/pull-requests/update-branch', (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.goto('/pull-requests.html');
    const refreshed = page.waitForRequest('**/api/v1/dashboard/refresh');
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
    await page.route('**/api/v1/pull-requests/update-branch', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    const refreshed = page.waitForRequest('**/api/v1/dashboard/refresh');
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
    await page.route('**/api/v1/pull-requests/update-branch', (route) =>
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
    await page.route('**/api/v1/pull-requests/close', (route) =>
      route.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    const refreshed = page.waitForRequest('**/api/v1/dashboard/refresh');
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

  for (const [name, button, armed] of [
    ['enable auto-merge', 'Enable auto-merge', false],
    ['cancel auto-merge', 'Cancel auto-merge', true],
  ] as const) {
    const route = armed
      ? '**/api/v1/pull-requests/auto-merge/cancel'
      : '**/api/v1/pull-requests/auto-merge';

    test(`${name}: a dropped request the server ran shows no error`, async ({
      page,
    }) => {
      await setup(page, () => [{ ...WAITING, autoMergeEnabled: !armed }], {
        ...WAITING,
        autoMergeEnabled: armed,
      });
      await page.route(route, (r) => r.abort('failed'));
      await page.goto('/pull-requests.html');
      const refreshed = page.waitForRequest('**/api/v1/dashboard/refresh');
      await clickAction(page, button);
      await refreshed;
      await expect(page.locator('body')).not.toContainText(
        "Couldn't reach the server",
      );
      await expect(line(page)).toHaveCount(0);
      // The fresh snapshot was applied: the row shows the new state.
      const pill = row(page).locator('.attr-chip.auto-merge');
      await expect(pill).toHaveCount(armed ? 0 : 1);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });

    test(`${name}: a request that never got through still says so`, async ({
      page,
    }) => {
      const same = { ...WAITING, autoMergeEnabled: armed };
      await setup(page, () => [same], same);
      await page.route(route, (r) => r.abort('failed'));
      await page.goto('/pull-requests.html');
      await clickAction(page, button);
      await expect(line(page)).toContainText("Couldn't reach the server");
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('cancel auto-merge: a snapshot that cannot say still reports the dropped request', async ({
    page,
  }) => {
    const armed = { ...WAITING, autoMergeEnabled: true };
    await setup(page, () => [{ ...WAITING, autoMergeEnabled: null }], armed);
    await page.route('**/api/v1/pull-requests/auto-merge/cancel', (r) =>
      r.abort('failed'),
    );
    await page.goto('/pull-requests.html');
    await clickAction(page, 'Cancel auto-merge');
    await expect(line(page)).toContainText("Couldn't reach the server");
  });
});
