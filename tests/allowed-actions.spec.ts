import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

// #805: a row renders the actions the server lists, and holds no copy of the
// rules. Each case below states `allowedActions` itself, in a way that
// disagrees with what the page used to work out from the raw fields, so
// passing proves the row follows the server's answer.

type Allowed = {
  action: string;
  primary?: boolean;
  blocked?: { code: string; message: string; next?: string };
};

function makePR(overrides: Record<string, unknown> = {}) {
  return {
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
    behind: false,
    ...overrides,
  };
}

async function open(page: Page, pr: Record<string, unknown>) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: false }),
    }),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  // Dependabot and Renovate pull requests are on the Bots page (#1192).
  await page.goto(
    /^(dependabot|renovate)/.test(String(pr.author))
      ? '/bots.html'
      : '/pull-requests.html',
  );
  await expect(page.locator('#pr-rows .row')).toHaveCount(1);
  return page.locator('#pr-rows .row').first();
}

const withActions = (actions: Allowed[]) => makePR({ allowedActions: actions });
// The row's dialog footer, opened.
const footerOf = async (row: Locator) =>
  actionsFooter(await openActionsDialog(row));
const names = async (row: Locator) => {
  // Every button on the row, then every action in its dialog.
  const onRow = await row.getByRole('button').allInnerTexts();
  const dialog = await footerOf(row);
  const inDialog = await dialog
    .locator('.details-actions')
    .getByRole('button')
    .allInnerTexts();
  return [...onRow, ...inDialog].map((t) => t.trim());
};

// The row draws one control (#943 step 3): the action the server marks
// primary, or, with none primary and Merge locked, the greyed Merge with its
// reason, or a Renovate rebase that is already waiting, or nothing. Everything
// else is in the pop-up's footer.
const ROW_ACTION =
  /^(Merge|Update branch|Close pull request|Enable auto-merge|Cancel auto-merge|Dependabot: |Renovate: |Cancel Renovate rebase)/;
const rowActions = async (row: Locator) =>
  (await row.getByRole('button', { name: ROW_ACTION }).allInnerTexts()).map(
    (t) => t.trim(),
  );

test.describe('the row draws one action (#943)', () => {
  const blockedMerge = {
    action: 'merge',
    blocked: { code: 'checks_pending', message: 'Waiting for CI to finish' },
  };

  test('the primary action is the only one drawn, however many are offered', async ({
    page,
  }) => {
    const row = await open(
      page,
      withActions([
        { action: 'merge', primary: true },
        { action: 'auto_merge' },
        { action: 'close' },
      ]),
    );
    expect(await rowActions(row)).toEqual(['Merge']);
  });

  test('with no primary and Merge locked, the row shows the locked Merge and its reason', async ({
    page,
  }) => {
    const row = await open(
      page,
      withActions([
        blockedMerge,
        { action: 'auto_merge' },
        { action: 'close' },
      ]),
    );
    expect(await rowActions(row)).toEqual(['Merge']);
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText('Waiting for CI to finish');
  });

  test('with no primary and Merge offered, the row draws nothing', async ({
    page,
  }) => {
    // Failing CI: the server offers Merge but doesn't make it primary.
    const row = await open(
      page,
      withActions([
        { action: 'merge' },
        { action: 'auto_merge' },
        { action: 'close' },
      ]),
    );
    expect(await rowActions(row)).toEqual([]);
  });

  test('a Renovate rebase that is already requested leaves only the cancel on the row', async ({
    page,
  }) => {
    const row = await open(
      page,
      makePR({
        author: 'renovate[bot]',
        kind: 'dependency',
        behind: true,
        allowedActions: [
          {
            action: 'merge',
            blocked: { code: 'behind', message: 'Behind the base branch' },
          },
          { action: 'close' },
          { action: 'cancel_renovate_rebase' },
        ],
        status: { code: 'behind', message: 'Behind the base branch' },
      }),
    );
    expect(await rowActions(row)).toEqual(['Cancel Renovate rebase']);
    await expect(
      row.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toHaveCount(0);
  });
});

test.describe('the row follows allowedActions (#805)', () => {
  test("a blocked Merge shows the server's own reason and what unlocks it", async ({
    page,
  }) => {
    // Raw fields say a clean, passing, mergeable pull request.
    const row = await open(
      page,
      withActions([
        {
          action: 'merge',
          blocked: {
            code: 'blocked_by_protection',
            message: 'Server says no',
            next: 'Server says wait',
          },
        },
        { action: 'close' },
      ]),
    );

    await expect(row).toContainText('Server says no');
    await expect(row).toContainText('Server says wait');
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  test('an unblocked Merge is clickable even where the raw fields said blocked', async ({
    page,
  }) => {
    const row = await open(
      page,
      makePR({
        draft: true,
        ci: 'failure',
        mergeStatus: 'blocked',
        allowedActions: [{ action: 'merge' }, { action: 'close' }],
      }),
    );

    // Not primary, so the row draws no Merge; the pop-up's footer has it.
    const merge = (await footerOf(row)).getByRole('button', {
      name: 'Merge',
      exact: true,
    });
    await expect(merge).toBeVisible();
    await expect(merge).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('Update branch shows only when listed, whatever the raw fields say', async ({
    page,
  }) => {
    const listed = await open(
      page,
      makePR({
        behind: false,
        allowedActions: [
          { action: 'merge' },
          { action: 'update_branch' },
          { action: 'close' },
        ],
      }),
    );
    await expect(
      (await footerOf(listed)).getByRole('button', { name: 'Update branch' }),
    ).toBeVisible();
  });

  test('a behind pull request with no update_branch entry has no Update branch', async ({
    page,
  }) => {
    const row = await open(
      page,
      makePR({
        behind: true,
        allowedActions: [{ action: 'merge' }, { action: 'close' }],
      }),
    );
    await expect(
      row.getByRole('button', { name: 'Update branch' }),
    ).toHaveCount(0);
  });

  test("Update branch listed as blocked is locked with the server's reason", async ({
    page,
  }) => {
    const row = await open(
      page,
      makePR({
        behind: true,
        allowedActions: [
          { action: 'merge' },
          {
            action: 'update_branch',
            blocked: { code: 'conflict', message: 'Server conflict words' },
          },
          { action: 'close' },
        ],
      }),
    );
    // A blocked action is never primary, so the row draws no button for it;
    // the pop-up's footer has it locked, with the server's reason.
    const footer = await footerOf(row);
    await expect(footer).toContainText('Server conflict words');
    await expect(
      footer.getByRole('button', { name: 'Update branch' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  test('Enable auto-merge shows only when listed', async ({ page }) => {
    // Clean and passing: the old rule hid it (#662).
    const row = await open(
      page,
      makePR({
        allowedActions: [
          { action: 'merge' },
          { action: 'auto_merge' },
          { action: 'close' },
        ],
      }),
    );
    await expect(
      (await footerOf(row)).getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeVisible();
  });

  test('no auto_merge entry means no Enable auto-merge', async ({ page }) => {
    const row = await open(
      page,
      makePR({
        ci: 'pending',
        mergeStatus: 'blocked',
        allowedActions: [
          {
            action: 'merge',
            blocked: {
              code: 'checks_pending',
              message: 'Waiting for CI to finish',
            },
          },
          { action: 'close' },
        ],
      }),
    );
    await expect(
      (await footerOf(row)).getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveCount(0);
  });

  test('Dependabot actions show for whoever the server lists them for', async ({
    page,
  }) => {
    // Authored by a person: the old rule showed none.
    const row = await open(
      page,
      makePR({
        author: 'a-person',
        allowedActions: [
          { action: 'merge' },
          { action: 'dependabot_rebase' },
          { action: 'dependabot_recreate' },
          { action: 'close' },
        ],
      }),
    );
    const footer = await footerOf(row);
    await expect(
      footer.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toBeVisible();
    await expect(
      footer.getByRole('button', { name: 'Dependabot: Recreate' }),
    ).toBeVisible();
  });

  test('a Dependabot-authored pull request with none listed has no Dependabot actions', async ({
    page,
  }) => {
    const row = await open(
      page,
      makePR({
        author: 'dependabot',
        allowedActions: [{ action: 'merge' }, { action: 'close' }],
      }),
    );
    await expect(row.getByRole('button', { name: /^Dependabot:/ })).toHaveCount(
      0,
    );
    await expect(
      (await footerOf(row)).getByRole('button', { name: /^Dependabot:/ }),
    ).toHaveCount(0);
  });

  test('Renovate rebase shows only when listed', async ({ page }) => {
    const listed = await open(
      page,
      makePR({
        author: 'a-person',
        allowedActions: [
          { action: 'merge' },
          { action: 'renovate_rebase' },
          { action: 'close' },
        ],
      }),
    );
    await expect(
      (await footerOf(listed)).getByRole('button', {
        name: 'Renovate: Rebase',
      }),
    ).toBeVisible();
  });

  test('Close shows only when listed', async ({ page }) => {
    const row = await open(
      page,
      makePR({ allowedActions: [{ action: 'merge' }] }),
    );
    expect(await names(row)).not.toContain('Close pull request');
  });
});
