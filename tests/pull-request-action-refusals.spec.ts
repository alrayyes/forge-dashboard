import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// Close, Update branch, Enable auto-merge, and the Dependabot and Renovate
// rebases answer a refused request the way Merge does (#751): a structured
// ActionError with a `code` and a `message`. These tests mock that response
// and check each action's row and toast render it. Which code a forge
// refusal earns is tested in Go (internal/api, internal/dashboard).

const REPO = 'alrayyes/forge-dashboard';

interface MockPR {
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  ci: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  mergeStatus: string;
  behind: boolean;
  autoMergeEnabled: boolean;
}

function makePR(overrides: Partial<MockPR> = {}): MockPR {
  return {
    forge: 'github',
    repo: REPO,
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: false,
    autoMergeEnabled: false,
    ...overrides,
  };
}

function snapshot(prs: MockPR[]) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: prs,
    issues: [],
  });
}

async function mockBoard(page: Page, prs: MockPR[]) {
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(prs),
    }),
  );
  await page.route('**/api/dashboard/refresh', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(prs),
    }),
  );
  await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: false }),
    }),
  );
}

async function openMoreActions(row: Locator) {
  const trigger = row.getByRole('button', { name: 'More actions' });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click();
  }
}

type Driver = {
  name: string;
  endpoint: string;
  pr: Partial<MockPR>;
  // The accessible name of the action's button.
  button: string;
  // Clicks through to the request, confirm step included.
  act: (row: Locator) => Promise<void>;
  // Finds the action's button again, after a refusal.
  find: (row: Locator) => Promise<Locator>;
  // Where an action's lock leaves a Retry that re-checks the row instead of
  // a disabled button (Update branch).
  retryOnLock?: boolean;
  // A code only this action has, with the message the server sends.
  specific?: { code: string; message: string; locks: boolean };
};

const drivers: Driver[] = [
  {
    name: 'Close',
    endpoint: '**/api/pull-requests/close',
    pr: {},
    button: 'Close',
    act: async (row) => {
      await openMoreActions(row);
      await row.getByRole('button', { name: 'Close', exact: true }).click();
      await row.getByRole('button', { name: 'Confirm close?' }).click();
    },
    find: async (row) => {
      await openMoreActions(row);
      return row.getByRole('button', { name: 'Close', exact: true });
    },
  },
  {
    name: 'Update branch',
    endpoint: '**/api/pull-requests/update-branch',
    pr: { behind: true },
    button: 'Update branch',
    act: async (row) => {
      await row.getByRole('button', { name: 'Update branch' }).click();
    },
    find: async (row) => row.getByRole('button', { name: 'Update branch' }),
    retryOnLock: true,
    specific: {
      code: 'conflict',
      message: "Can't update cleanly. Resolve the conflict on the forge.",
      locks: true,
    },
  },
  {
    name: 'Enable auto-merge',
    endpoint: '**/api/pull-requests/auto-merge',
    pr: {},
    button: 'Enable auto-merge',
    act: async (row) => {
      await openMoreActions(row);
      await row.getByRole('button', { name: 'Enable auto-merge' }).click();
    },
    find: async (row) => {
      await openMoreActions(row);
      return row.getByRole('button', { name: 'Enable auto-merge' });
    },
    specific: {
      code: 'auto_merge_not_allowed',
      message:
        "Auto-merge isn't allowed for this pull request. Turn it on in the repo's settings.",
      locks: true,
    },
  },
  {
    name: 'Dependabot: Rebase',
    endpoint: '**/api/pull-requests/dependabot-action',
    pr: { author: 'dependabot' },
    button: 'Dependabot: Rebase',
    act: async (row) => {
      await openMoreActions(row);
      await row.getByRole('button', { name: 'Dependabot: Rebase' }).click();
    },
    find: async (row) => {
      await openMoreActions(row);
      return row.getByRole('button', { name: 'Dependabot: Rebase' });
    },
  },
  {
    name: 'Renovate: Rebase',
    endpoint: '**/api/pull-requests/renovate-rebase',
    pr: { author: 'renovate[bot]' },
    button: 'Renovate: Rebase',
    act: async (row) => {
      await openMoreActions(row);
      await row.getByRole('button', { name: 'Renovate: Rebase' }).click();
    },
    find: async (row) => {
      await openMoreActions(row);
      return row.getByRole('button', { name: 'Renovate: Rebase' });
    },
    specific: {
      code: 'label_missing',
      message:
        "The rebase label doesn't exist on this repo. Create it there first.",
      locks: true,
    },
  },
];

function refuse(
  page: Page,
  d: Driver,
  status: number,
  body: Record<string, unknown>,
) {
  return page.route(d.endpoint, (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const d of drivers) {
  test.describe(`${d.name} explains a refusal from the server code`, () => {
    test.beforeEach(async ({ page, request, baseURL }) => {
      await registerViaInvite(
        page,
        request,
        baseURL,
        `pr-refusal-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        'PR Refusal User',
      );
    });

    async function start(page: Page) {
      await mockBoard(page, [makePR(d.pr)]);
      return page.locator('#pr-rows .row').first();
    }

    test('already_merged: the row reads Merged and a polite toast says so', async ({
      page,
    }) => {
      await start(page);
      await refuse(page, d, 409, {
        error:
          'forgejo: PATCH x: cannot change state of this pull request, it was already merged',
        code: 'already_merged',
        message: 'This pull request was already merged.',
      });
      await page.reload();
      const row = page.locator('#pr-rows .row').first();

      await d.act(row);

      await expect(row.locator('.row-settled')).toHaveText('Merged');
      const toast = page.locator('#feedback-toasts .feedback-toast');
      await expect(toast).toContainText(`${REPO}#42`);
      await expect(toast).toContainText(/already merged/i);
      await expect(toast).toHaveAttribute('data-kind', 'success');
      await expect(row.locator('.row-feedback')).toHaveCount(0);
      await expect(page.locator('#error-banner')).toHaveCount(0);
      await expect(
        row.getByRole('button', { name: d.button, exact: true }),
      ).toHaveCount(0);
      await axeClean(page);
    });

    test('already_closed: the row reads Closed', async ({ page }) => {
      await start(page);
      await refuse(page, d, 409, {
        error: 'x',
        code: 'already_closed',
        message: 'This pull request was closed without merging.',
      });
      await page.reload();
      const row = page.locator('#pr-rows .row').first();

      await d.act(row);

      await expect(row.locator('.row-settled')).toHaveText('Closed');
      await expect(page.locator('#feedback-toasts')).toContainText(
        /already closed/i,
      );
    });

    test('an earlier failure line clears once the PR is found merged', async ({
      page,
    }) => {
      await start(page);
      await refuse(page, d, 502, {
        error: 'x: EOF',
        code: 'unknown',
        message: 'EOF',
      });
      await page.reload();
      const row = page.locator('#pr-rows .row').first();
      await d.act(row);
      await expect(row.locator('.row-feedback')).toContainText('EOF');

      await page.unroute(d.endpoint);
      await refuse(page, d, 409, {
        error: 'x',
        code: 'already_merged',
        message: 'This pull request was already merged.',
      });
      await (await d.find(row)).click();
      // Close asks again; the others act straight away.
      const confirm = row.getByRole('button', { name: 'Confirm close?' });
      if (await confirm.isVisible()) await confirm.click();

      await expect(row.locator('.row-settled')).toHaveText('Merged');
      await expect(row.locator('.row-feedback')).toHaveCount(0);
    });

    test('rate_limited: locks with no Retry and says when it resets, from resetsAt', async ({
      page,
    }) => {
      await start(page);
      await refuse(page, d, 429, {
        error: 'github: rate limit exceeded',
        code: 'rate_limited',
        message:
          "The forge's API rate limit is reached. Try again once it resets.",
        resetsAt: new Date(Date.now() + 20 * 60000).toISOString(),
      });
      await page.reload();
      const row = page.locator('#pr-rows .row').first();

      await d.act(row);

      const button = await d.find(row);
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      await expect(button).toHaveAccessibleDescription(/rate limit reached/i);
      await expect(button).toHaveAccessibleDescription(/in \d+ min/);
      await expect(
        page.locator('#feedback-toasts .feedback-toast[data-kind="error"]'),
      ).toBeVisible();
      await axeClean(page);
    });

    test('permission: locks with no Retry and points to Settings', async ({
      page,
    }) => {
      await start(page);
      await refuse(page, d, 403, {
        error: 'github: Forbidden',
        code: 'permission',
        message: 'Missing permission — check your token in Settings.',
      });
      await page.reload();
      const row = page.locator('#pr-rows .row').first();

      await d.act(row);

      const button = await d.find(row);
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      await expect(button).toHaveAccessibleDescription(/token in Settings/);
    });

    test('unknown: shows the forge text and keeps the action clickable', async ({
      page,
    }) => {
      await start(page);
      await refuse(page, d, 502, {
        error: 'x: EOF',
        code: 'unknown',
        message: 'EOF',
      });
      await page.reload();
      const row = page.locator('#pr-rows .row').first();

      await d.act(row);

      await expect(row.locator('.row-feedback')).toContainText('EOF');
      const button = await d.find(row);
      await expect(button).toBeEnabled();
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('#feedback-toasts')).toContainText('EOF');
      await axeClean(page);
    });

    test('a refusal with no code is treated as unknown and never says only "failed"', async ({
      page,
    }) => {
      await start(page);
      await refuse(page, d, 409, { error: 'x: something the forge said' });
      await page.reload();
      const row = page.locator('#pr-rows .row').first();

      await d.act(row);

      // The raw string stays in the server log (#752): one plain sentence.
      await expect(row.locator('.row-feedback')).toContainText(
        'The forge refused this action and gave no reason.',
      );
      await expect(row.locator('.row-feedback')).not.toContainText(
        'something the forge said',
      );
      await expect(await d.find(row)).toBeEnabled();
    });

    if (d.specific) {
      const specific = d.specific;
      test(`${specific.code}: the server reason shows and the action locks`, async ({
        page,
      }) => {
        await start(page);
        await refuse(page, d, 409, {
          error: 'x',
          code: specific.code,
          message: specific.message,
        });
        await page.reload();
        const row = page.locator('#pr-rows .row').first();

        await d.act(row);

        await expect(row.locator('.row-feedback')).toContainText(
          specific.message,
        );
        if (d.retryOnLock) {
          await expect(
            row.getByRole('button', { name: 'Retry' }),
          ).toBeVisible();
          await expect(
            row.getByRole('button', { name: d.button, exact: true }),
          ).toHaveCount(0);
        } else {
          const button = await d.find(row);
          await expect(button).toHaveAttribute('aria-disabled', 'true');
          await expect(button).toHaveAccessibleDescription(specific.message);
        }
        await axeClean(page);
      });
    }
  });
}

test.describe('Enable auto-merge with a transient refusal', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `pr-refusal-am-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'PR Refusal User',
    );
  });

  test('checks_pending keeps the button clickable: trying again once checks settle can work', async ({
    page,
  }) => {
    await mockBoard(page, [makePR()]);
    await page.route('**/api/pull-requests/auto-merge', (route: Route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: graphql: Pull request is in unstable status',
          code: 'checks_pending',
          message:
            'GitHub reports this pull request as unstable: a non-required check is still running or has failed. Try again once it settles.',
        }),
      }),
    );
    await page.reload();
    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Enable auto-merge' }).click();

    await expect(row.locator('.row-feedback')).toContainText(
      'Try again once it settles',
    );
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeEnabled();
  });

  test('ready_to_merge points to Merge and locks', async ({ page }) => {
    await mockBoard(page, [makePR()]);
    await page.route('**/api/pull-requests/auto-merge', (route: Route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: graphql: Pull request is in clean status',
          code: 'ready_to_merge',
          message:
            "This pull request is already ready to merge, so there's nothing for auto-merge to wait for. Use Merge instead.",
        }),
      }),
    );
    await page.reload();
    const row = page.locator('#pr-rows .row').first();
    await openMoreActions(row);
    await row.getByRole('button', { name: 'Enable auto-merge' }).click();

    await expect(row.locator('.row-feedback')).toContainText(
      'Use Merge instead',
    );
    await openMoreActions(row);
    await expect(
      row.getByRole('button', { name: 'Enable auto-merge' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });
});
