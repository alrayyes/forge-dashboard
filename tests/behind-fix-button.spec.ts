import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

// The "Behind the base branch" warning carries its own fix button: the server
// names the action on `status.action` and the page draws that button inside
// the status line, with no second copy in the row. The pop-up's footer keeps its own list.
// https://github.com/alrayyes/forge-dashboard/issues/1943

function pr(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number: 7,
    title: 'Behind',
    url: 'https://example.com/pull/7',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    ...overrides,
  };
}

async function open(
  page: Page,
  pullRequest: unknown,
  path = '/pull-requests.html',
) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pullRequest],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
  return page.locator('#pr-rows > .row').first();
}

const cases = [
  {
    name: 'a person',
    overrides: {},
    button: 'Update branch',
    path: '/pull-requests.html',
  },
  {
    name: 'Dependabot',
    overrides: { author: 'dependabot[bot]' },
    button: 'Dependabot: Rebase',
    path: '/bots.html',
  },
  {
    name: 'Renovate',
    overrides: { author: 'renovate[bot]' },
    button: 'Renovate: Rebase',
    path: '/bots.html',
  },
];

for (const { name, overrides, button, path } of cases) {
  test(`a behind pull request from ${name} has ${button} inside its warning, once in the row`, async ({
    page,
  }) => {
    const row = await open(page, pr(overrides), path);

    const status = row.locator('.status-area');
    await expect(status).toContainText('Behind the base branch');
    await expect(status.getByRole('button', { name: button })).toBeVisible();
    await expect(row.getByRole('button', { name: button })).toHaveCount(1);

    // The pop-up keeps every action in its footer, so its status block
    // doesn't repeat the button.
    const dialog = await openActionsDialog(row);
    await expect(
      actionsFooter(dialog).getByRole('button', { name: button }),
    ).toBeVisible();
    await expect(
      dialog.locator('.details-status-block').getByRole('button'),
    ).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('a behind Dependabot pull request still has Recreate in the dialog', async ({
  page,
}) => {
  const row = await open(page, pr({ author: 'dependabot[bot]' }), '/bots.html');
  const dialog = await openActionsDialog(row);
  await expect(
    actionsFooter(dialog).getByRole('button', { name: 'Dependabot: Recreate' }),
  ).toBeVisible();
});

test('a behind pull request with a conflict puts no button in its warning', async ({
  page,
}) => {
  const row = await open(page, pr({ mergeStatus: 'conflicting' }));
  const status = row.locator('.status-area');
  await expect(status).toContainText('Merge conflict');
  await expect(status.getByRole('button')).toHaveCount(0);
});

test('the button in the warning acts once and shows it is queued', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/api/v1/pull-requests/update-branch', async (route) => {
    calls += 1;
    await route.fulfill({ status: 202 });
  });
  const row = await open(page, pr());
  await row
    .locator('.status-area')
    .getByRole('button', { name: 'Update branch' })
    .click();
  await expect(
    row.locator('.status-area').getByRole('button', { name: 'Queued…' }),
  ).toBeDisabled();
  expect(calls).toBe(1);
});

test('on a phone the pop-up keeps the fix button as a 44px target in its footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const row = await open(page, pr());
  const dialog = await openActionsDialog(row);
  const button = actionsFooter(dialog).getByRole('button', {
    name: 'Update branch',
  });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await expect(
    dialog.locator('.details-status-block').getByRole('button'),
  ).toHaveCount(0);
});

test('a Renovate rebase that is already requested has no button in the warning and keeps only the cancel in the row', async ({
  page,
}) => {
  const behind = {
    code: 'behind',
    message: 'Behind the base branch',
    next: 'Bring it up to date to unlock Merge',
  };
  const row = await open(
    page,
    pr({
      author: 'renovate[bot]',
      allowedActions: [
        { action: 'merge', blocked: behind },
        { action: 'close' },
        { action: 'cancel_renovate_rebase' },
      ],
      // No `action`: the rebase is already requested.
      status: behind,
      kind: 'dependency',
    }),
    '/bots.html',
  );
  const status = row.locator('.status-area');
  await expect(status).toContainText('Behind the base branch');
  await expect(status.getByRole('button')).toHaveCount(0);
  await expect(
    row.getByRole('button', { name: 'Renovate: Rebase' }),
  ).toHaveCount(0);
  await expect(
    row.getByRole('button', { name: 'Cancel Renovate rebase' }),
  ).toBeVisible();
});
