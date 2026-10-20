import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The "Behind the base branch" warning carries its own fix button: the server
// names the action on `status.action` and the page draws that button inside
// the status line, with no second copy in the row or the dialog's footer.
// https://github.com/alrayyes/forge-dashboard/issues/1943

test.use({ storageState: SHARED_STORAGE_STATE_PATH });

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
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
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
  test(`a behind pull request from ${name} has ${button} inside its warning, and nowhere else`, async ({
    page,
  }) => {
    const row = await open(page, pr(overrides), path);

    const status = row.locator('.status-area');
    await expect(status).toContainText('Behind the base branch');
    await expect(status.getByRole('button', { name: button })).toBeVisible();
    await expect(row.getByRole('button', { name: button })).toHaveCount(1);

    const dialog = await openActionsDialog(row);
    await expect(
      dialog.locator('.details-status-block').getByRole('button', {
        name: button,
      }),
    ).toBeVisible();
    await expect(
      actionsFooter(dialog).getByRole('button', { name: button }),
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
  await page.route('**/api/pull-requests/update-branch', async (route) => {
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
