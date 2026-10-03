import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #805: a row renders the actions the server lists, and holds no copy of the
// rules. Each case below states `allowedActions` itself, in a way that
// disagrees with what the page used to work out from the raw fields, so
// passing proves the row follows the server's answer.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `allowed-actions-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Allowed Actions');
}

type Allowed = {
  action: string;
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
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: false }),
    }),
  );
  await page.route('**/api/dashboard*', (route: Route) =>
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
  await page.reload();
  await expect(page.locator('#pr-rows .row')).toHaveCount(1);
  return page.locator('#pr-rows .row').first();
}

const withActions = (actions: Allowed[]) => makePR({ allowedActions: actions });
const names = async (row: ReturnType<Page['locator']>) => {
  // Open the More actions menu if there is one, then list every button.
  const trigger = row.getByRole('button', { name: 'More actions' });
  if (await trigger.count()) await trigger.click();
  return (await row.getByRole('button').allInnerTexts()).map((t) => t.trim());
};

test.describe('the row follows allowedActions (#805)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

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

    const merge = row.getByRole('button', { name: 'Merge', exact: true });
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
      listed.getByRole('button', { name: 'Update branch' }),
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
    await expect(row).toContainText('Server conflict words');
    await expect(
      row.getByRole('button', { name: 'Update branch' }),
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
    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
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
    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
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
    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(
      row.getByRole('button', { name: 'Dependabot: Rebase' }),
    ).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Dependabot: Recreate' }),
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
    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(row.getByRole('button', { name: /^Dependabot:/ })).toHaveCount(
      0,
    );
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
    await listed.getByRole('button', { name: 'More actions' }).click();
    await expect(
      listed.getByRole('button', { name: 'Renovate: Rebase' }),
    ).toBeVisible();
  });

  test('Close shows only when listed', async ({ page }) => {
    const row = await open(
      page,
      makePR({ allowedActions: [{ action: 'merge' }] }),
    );
    expect(await names(row)).not.toContain('Close');
  });
});
