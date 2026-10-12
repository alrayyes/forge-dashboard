import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// A failed action keeps its plain sentence on the row, and a Copy button
// beside it copies what the server really answered: the status, the body as
// received (the raw `error` included) and the action's context, so the real
// forge text can be pasted into a ticket or a chat.
// https://github.com/alrayyes/forge-dashboard/issues/1323

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `copy-failure-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Copy Failure');
}

const REPO = 'alrayyes/obsidian';
const RAW =
  'forgejo: POST /repos/alrayyes/obsidian/issues/244/labels: 403 raw refusal text from the forge';

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'forgejo',
    repo: REPO,
    number: 244,
    title: 'Update dependency foo to v2',
    url: 'https://example.com/244',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    allowedActions: [
      { action: 'merge' },
      { action: 'close' },
      { action: 'auto_merge' },
      { action: 'update_branch' },
      { action: 'renovate_rebase' },
    ],
    ...overrides,
  };
}

async function open(page: Page, pr = makePR()) {
  const answer = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
      }),
    });
  await page.route('**/api/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/dashboard*', answer);
  await page.route('**/api/dashboard/refresh*', answer);
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows .row').first()).toBeVisible();
  return page.locator('#pr-rows .row').first();
}

const refuse = (page: Page, endpoint: string, status: number, body: object) =>
  page.route(`**/api/pull-requests/${endpoint}`, (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );

const REFUSAL = { error: RAW, code: 'unknown' };

// Every way to start an action that can fail, ending with the failure showing.
const ACTIONS: {
  name: string;
  endpoint: string;
  action: string;
  start: (row: Locator) => Promise<void>;
}[] = [
  {
    name: 'Merge',
    endpoint: 'merge',
    action: 'merge',
    start: async (row) => {
      await row.getByRole('button', { name: 'Merge', exact: true }).click();
      await row.getByRole('button', { name: 'Confirm merge?' }).click();
    },
  },
  {
    name: 'Close',
    endpoint: 'close',
    action: 'close',
    start: async (row) => {
      await row.getByRole('button', { name: 'More actions' }).click();
      await row
        .getByRole('button', { name: 'Close pull request', exact: true })
        .click();
      await row
        .getByRole('button', { name: 'Confirm close pull request?' })
        .click();
    },
  },
  {
    name: 'Update branch',
    endpoint: 'update-branch',
    action: 'update-branch',
    start: async (row) => {
      await row.getByRole('button', { name: 'Update branch' }).click();
    },
  },
  {
    name: 'Enable auto-merge',
    endpoint: 'auto-merge',
    action: 'auto-merge',
    start: async (row) => {
      await row.getByRole('button', { name: 'More actions' }).click();
      await row.getByRole('button', { name: 'Enable auto-merge' }).click();
    },
  },
  {
    name: 'Renovate: Rebase',
    endpoint: 'renovate-rebase',
    action: 'renovate',
    start: async (row) => {
      await row.getByRole('button', { name: 'More actions' }).click();
      await row.getByRole('button', { name: 'Renovate: Rebase' }).click();
    },
  },
];

const copyIn = (scope: Locator) =>
  scope.getByRole('button', { name: 'Copy error details' });

async function readClipboard(page: Page): Promise<Record<string, unknown>> {
  return JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
}

test.describe('Copy error details on a failed action (#1323)', () => {
  test.beforeEach(async ({ page, request, baseURL, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await registerAndSignIn(page, request, baseURL);
  });

  for (const a of ACTIONS) {
    test(`${a.name}: a Copy button sits beside the failure on the row`, async ({
      page,
    }) => {
      await refuse(page, a.endpoint, 403, REFUSAL);
      const row = await open(page);
      await a.start(row);

      const line = row.locator('.row-feedback-line[data-phase="failed"]');
      await expect(line).toBeVisible();
      await expect(copyIn(line)).toBeVisible();
    });
  }

  // Dependabot's Rebase and Recreate share one feedback key, so the copied
  // action has to say which of the two failed.
  for (const verb of ['Rebase', 'Recreate'] as const) {
    test(`Dependabot ${verb} copies which command it was`, async ({ page }) => {
      await page.route(
        '**/api/pull-requests/dependabot-action',
        (route: Route) =>
          route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify(REFUSAL),
          }),
      );
      const row = await open(
        page,
        makePR({
          forge: 'github',
          behind: false,
          allowedActions: [
            { action: 'merge' },
            { action: 'dependabot_rebase' },
            { action: 'dependabot_recreate' },
          ],
        }),
      );
      await row.getByRole('button', { name: 'More actions' }).click();
      await row
        .getByRole('button', { name: `Dependabot: ${verb}`, exact: true })
        .click();
      // The error toast covers the row at this size; its Copy is the same.
      await copyIn(page.locator('#feedback-toasts .feedback-toast')).click();

      expect((await readClipboard(page)).action).toBe(
        `dependabot-${verb.toLowerCase()}`,
      );
    });
  }

  test('the row keeps showing the plain sentence, never the raw text', async ({
    page,
  }) => {
    await refuse(page, 'renovate-rebase', 403, REFUSAL);
    const row = await open(page);
    await ACTIONS[4].start(row);

    await expect(row.locator('.row-feedback-line')).toContainText(
      'The forge refused this action and gave no reason.',
    );
    await expect(row.locator('.row-feedback-line')).not.toContainText(
      'raw refusal text',
    );
  });

  test('Copy puts one JSON object on the clipboard: status, the body as received, the action, the pull request and a time', async ({
    page,
  }) => {
    await refuse(page, 'renovate-rebase', 403, REFUSAL);
    const row = await open(page);
    await ACTIONS[4].start(row);
    await copyIn(row).click();

    const payload = await readClipboard(page);
    expect(payload).toMatchObject({
      status: 403,
      response: REFUSAL,
      action: 'renovate',
      forge: 'forgejo',
      repo: REPO,
      number: 244,
    });
    expect(Date.parse(String(payload.at))).not.toBeNaN();
  });

  test('the button says Copied, then Copy again', async ({ page }) => {
    await refuse(page, 'renovate-rebase', 403, REFUSAL);
    const row = await open(page);
    await ACTIONS[4].start(row);
    const copy = copyIn(row);
    await copy.click();

    await expect(copy).toHaveText('Copied');
    await expect(copy).toHaveText('Copy', { timeout: 4000 });
  });

  test('a failure with only the network has Copy too, holding the action and the browser’s error', async ({
    page,
  }) => {
    await page.route('**/api/pull-requests/renovate-rebase', (route: Route) =>
      route.abort(),
    );
    const row = await open(page);
    await ACTIONS[4].start(row);
    await copyIn(row).click();

    const payload = await readClipboard(page);
    expect(payload).toMatchObject({
      status: null,
      action: 'renovate',
      repo: REPO,
      number: 244,
    });
    expect(String(payload.networkError).length).toBeGreaterThan(0);
  });

  test('a body that is not JSON is copied as the text it was', async ({
    page,
  }) => {
    await page.route('**/api/pull-requests/merge', (route: Route) =>
      route.fulfill({
        status: 502,
        contentType: 'text/html',
        body: '<html>Bad Gateway from the proxy</html>',
      }),
    );
    const row = await open(page);
    await ACTIONS[0].start(row);
    await copyIn(row).click();

    expect((await readClipboard(page)).response).toBe(
      '<html>Bad Gateway from the proxy</html>',
    );
  });

  test('the error toast has Copy too', async ({ page }) => {
    await refuse(page, 'renovate-rebase', 403, REFUSAL);
    const row = await open(page);
    await ACTIONS[4].start(row);

    const toast = page.locator('#feedback-toasts .feedback-toast');
    await expect(copyIn(toast)).toBeVisible();
    await copyIn(toast).click();
    expect((await readClipboard(page)).response).toEqual(REFUSAL);
  });

  test('it is reachable by keyboard and Enter copies', async ({ page }) => {
    await refuse(page, 'renovate-rebase', 403, REFUSAL);
    const row = await open(page);
    await ACTIONS[4].start(row);

    const copy = copyIn(row);
    await copy.focus();
    await expect(copy).toBeFocused();
    await page.keyboard.press('Enter');

    expect((await readClipboard(page)).status).toBe(403);
  });

  test('has no axe-core violations in the failure journey', async ({
    page,
  }) => {
    await refuse(page, 'renovate-rebase', 403, REFUSAL);
    const row = await open(page);
    await ACTIONS[4].start(row);
    await expect(copyIn(row)).toBeVisible();

    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
});

// Rerun failed checks fails inside the pipeline panel, not on the row, so its
// failure has its own line there (#1323, criterion 1).
test.describe('Copy error details on a failed Rerun failed checks (#1323)', () => {
  test.beforeEach(async ({ page, request, baseURL, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await registerAndSignIn(page, request, baseURL);
  });

  async function openPanel(page: Page) {
    await page.route('**/api/pull-requests/checks*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checks: [{ name: 'test', state: 'failure', url: '', required: true }],
        }),
      }),
    );
    const row = await open(
      page,
      makePR({
        ci: 'failure',
        allowedActions: [{ action: 'merge' }, { action: 'rerun_checks' }],
      }),
    );
    await row.getByRole('button', { name: /Open pipeline/ }).click();
    return page.getByRole('dialog', { name: 'Pipeline checks' });
  }

  test('the refusal shows its plain sentence with a Copy button beside it', async ({
    page,
  }) => {
    await refuse(page, 'rerun-checks', 403, REFUSAL);
    const dialog = await openPanel(page);
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();

    await expect(dialog.locator('.pipeline-error')).toContainText(
      'The forge refused this action and gave no reason.',
    );
    await expect(copyIn(dialog)).toBeVisible();
  });

  test('Copy holds the status, the body as received and the pull request', async ({
    page,
  }) => {
    await refuse(page, 'rerun-checks', 403, REFUSAL);
    const dialog = await openPanel(page);
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await copyIn(dialog).click();

    expect(await readClipboard(page)).toMatchObject({
      status: 403,
      response: REFUSAL,
      action: 'rerun-checks',
      forge: 'forgejo',
      repo: REPO,
      number: 244,
    });
  });

  test('a rerun that goes through has no Copy', async ({ page }) => {
    await page.route('**/api/pull-requests/rerun-checks', (route: Route) =>
      route.fulfill({ status: 204 }),
    );
    const dialog = await openPanel(page);
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();

    await expect(dialog.getByText('Rerun queued')).toBeVisible();
    await expect(copyIn(dialog)).toHaveCount(0);
  });

  test('trying again clears the earlier Copy', async ({ page }) => {
    const answer: { fail: boolean } = { fail: true };
    await page.route('**/api/pull-requests/rerun-checks', (route: Route) =>
      answer.fail
        ? route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify(REFUSAL),
          })
        : route.fulfill({ status: 204 }),
    );
    const dialog = await openPanel(page);
    const rerun = dialog.getByRole('button', { name: 'Rerun failed checks' });
    await rerun.click();
    await expect(copyIn(dialog)).toBeVisible();

    answer.fail = false;
    await rerun.click();

    await expect(dialog.getByText('Rerun queued')).toBeVisible();
    await expect(copyIn(dialog)).toHaveCount(0);
  });

  test('has no axe-core violations with the failure showing', async ({
    page,
  }) => {
    await refuse(page, 'rerun-checks', 403, REFUSAL);
    const dialog = await openPanel(page);
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(copyIn(dialog)).toBeVisible();

    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
});

test.describe('Copy error details without a clipboard (#1323)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    // An insecure context or a refused permission: writeText rejects.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: () => Promise.reject(new Error('NotAllowedError')),
        },
        configurable: true,
      });
    });
    await registerAndSignIn(page, request, baseURL);
  });

  test('the details show in a selectable box instead of failing silently', async ({
    page,
  }) => {
    await refuse(page, 'renovate-rebase', 403, REFUSAL);
    const row = await open(page);
    await ACTIONS[4].start(row);
    await copyIn(row).click();

    const box = row.getByRole('textbox', { name: 'Error details' });
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute('readonly', '');
    const shown = JSON.parse(await box.inputValue());
    expect(shown.response).toEqual(REFUSAL);
  });
});
