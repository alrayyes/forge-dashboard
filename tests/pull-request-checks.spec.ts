import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import {
  actionsFeedback,
  actionsFooter,
  closeActionsDialog,
  openActionsDialog,
} from './actions-dialog-helper';
import { test } from './server-fixture';

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
  allowedActions?: unknown[];
}

function makePR(overrides: Partial<MockPR> = {}): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Add structured logging',
    url: 'https://example.com/42',
    author: 'ryankes',
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

function mockDashboard(page: Page, forge: string, pr?: MockPR) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge, reachable: true, repoCount: 1 }],
        pullRequests: pr ? [pr] : [],
        issues: [],
      }),
    }),
  );
}

function mockChecks(page: Page, body: unknown, status = 200) {
  return page.route('**/api/pull-requests/checks*', (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

test.describe('pull request pipeline checks panel', () => {
  test.beforeEach(async ({ page }) => {
    // The live stream isn't part of these tests. Aborted, so no real stream
    // stays open against the server, and
    // a real snapshot can't be pushed over the mock.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
  });

  // #636: inline on the row itself, not tucked away — a read-only
  // drill-down reached on nearly every row with CI configured, not the rare,
  // mutating kind of action.
  test('a pull request with CI reported shows the View pipeline button inline on the row', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await expect(
      row.getByRole('button', { name: 'Open pipeline' }),
    ).toBeVisible();
  });

  test('a pull request with no CI at all shows no button', async ({ page }) => {
    await mockDashboard(page, 'github', makePR({ ci: 'none' }));
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    // Wait for the row: a count of zero proves nothing before it renders.
    await expect(row).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Open pipeline' }),
    ).toHaveCount(0);
  });

  test('clicking View pipeline requests checks for that exact pull request and lists them', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let requestURL = '';
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/1',
        },
        {
          name: 'test',
          state: 'running',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/2',
        },
      ],
    });
    page.on('request', (req) => {
      if (req.url().includes('/api/pull-requests/checks'))
        requestURL = req.url();
    });
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Open pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('alrayyes/forge-dashboard#42');

    const items = dialog.locator('.pipeline-check');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('build');
    await expect(items.nth(0)).toContainText('Passed');
    await expect(items.nth(1)).toContainText('test');
    await expect(items.nth(1)).toContainText('Running');

    const buildLink = dialog.getByRole('link', { name: 'View run: build' });
    await expect(buildLink).toHaveAttribute(
      'href',
      'https://github.com/alrayyes/forge-dashboard/runs/1',
    );
    await expect(buildLink).toHaveAttribute('target', '_blank');
    await expect(buildLink).toHaveAttribute('rel', 'noopener');

    const url = new URL(requestURL);
    expect(url.searchParams.get('forge')).toBe('github');
    expect(url.searchParams.get('fullName')).toBe('alrayyes/forge-dashboard');
    expect(url.searchParams.get('number')).toBe('42');
  });

  test('a skipped check shows its status but no "View run" link', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/1',
        },
        {
          name: 'deploy',
          state: 'skipped',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/2',
        },
      ],
    });
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Open pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const items = dialog.locator('.pipeline-check');
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toContainText('deploy');
    await expect(items.nth(1)).toContainText('Skipped');

    await expect(
      dialog.getByRole('link', { name: 'View run: build' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: 'View run: deploy' }),
    ).toHaveCount(0);
  });

  test('a check with no URL (a legacy commit status set with no target_url) shows no "View run" link', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://github.com/alrayyes/forge-dashboard/runs/1',
        },
        {
          name: 'legacy-ci',
          state: 'success',
          url: '',
        },
      ],
    });
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Open pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const items = dialog.locator('.pipeline-check');
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toContainText('legacy-ci');

    await expect(
      dialog.getByRole('link', { name: 'View run: build' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: 'View run: legacy-ci' }),
    ).toHaveCount(0);
  });

  test('no checks at all shows a plain "no CI configured" message', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, { checks: [] });
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Open pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toContainText(
      'No CI configured for this pull request.',
    );
  });

  // #681: required (blocks the merge) vs advisory, from the forge's own
  // branch protection. Absent `required` means the forge couldn't tell.
  test('checks with a known required flag are grouped Required first, then Advisory', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'codecov', state: 'success', url: '', required: false },
        { name: 'build', state: 'success', url: '', required: true },
        { name: 'lint', state: 'failure', url: '', required: true },
        { name: 'docs', state: 'failure', url: '', required: false },
      ],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const required = dialog.getByRole('group', { name: /^Required/ });
    const advisory = dialog.getByRole('group', { name: /^Advisory/ });
    await expect(required).toContainText('Required (2)');
    await expect(advisory).toContainText('Advisory (2)');

    // Required comes first in the DOM, failing required checks first
    // within it.
    const groups = dialog.locator('.pipeline-group');
    await expect(groups.nth(0)).toContainText('Required');
    await expect(groups.nth(1)).toContainText('Advisory');
    const requiredItems = required.locator('.pipeline-check');
    await expect(requiredItems.nth(0)).toContainText('lint');
    await expect(requiredItems.nth(1)).toContainText('build');
    await expect(advisory.locator('.pipeline-check')).toHaveCount(2);
  });

  test('a failing required check is flagged "Blocking" in text, an advisory failure is not', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'lint', state: 'failure', url: '', required: true },
        { name: 'build', state: 'success', url: '', required: true },
        { name: 'docs', state: 'failure', url: '', required: false },
      ],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const items = dialog.locator('.pipeline-check');
    await expect(
      items.filter({ hasText: 'lint' }).getByText('Blocking'),
    ).toBeVisible();
    await expect(
      items.filter({ hasText: 'build' }).getByText('Blocking'),
    ).toHaveCount(0);
    await expect(
      items.filter({ hasText: 'docs' }).getByText('Blocking'),
    ).toHaveCount(0);
  });

  test('a required workflow held for approval sits with the required checks and says it blocks (#1946)', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'docs', state: 'success', url: '', required: false },
        { name: 'ci', state: 'awaiting_approval', url: '', required: true },
      ],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const items = dialog.locator('.pipeline-check');
    await expect(
      items.filter({ hasText: 'ci' }).getByText('Blocking'),
    ).toBeVisible();
    await expect(
      items.filter({ hasText: 'docs' }).getByText('Blocking'),
    ).toHaveCount(0);
    await expect(items.first()).toContainText('ci');
  });

  test('with no known required flag on any check the flat list shows unchanged', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'build', state: 'success', url: '' },
        { name: 'test', state: 'failure', url: '' },
      ],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.locator('.pipeline-check')).toHaveCount(2);
    await expect(dialog.locator('.pipeline-group')).toHaveCount(0);
    await expect(dialog.getByText('Blocking')).toHaveCount(0);
  });

  test('checks of unknown required status sit apart from known groups, never in Advisory', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'build', state: 'success', url: '', required: true },
        { name: 'mystery', state: 'success', url: '' },
      ],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.getByRole('group', { name: /^Advisory/ })).toHaveCount(
      0,
    );
    await expect(
      dialog.getByRole('group', { name: /^Status unknown/ }),
    ).toContainText('mystery');
  });

  test('a failed check shows its failed step, how long it ran and the log excerpt as plain text', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        {
          name: 'test',
          state: 'failure',
          url: 'https://example.com/1',
          durationSeconds: 125,
          failedStep: 'Run tests',
          excerpt: 'FAIL internal/api\n<img src=x onerror=alert(1)>',
        },
        { name: 'build', state: 'success', url: '', durationSeconds: 42 },
      ],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const failed = dialog.locator('.pipeline-check', { hasText: 'test' });
    await expect(failed.getByText('Failed step: Run tests')).toBeVisible();
    await expect(failed.getByText('2m 5s')).toBeVisible();
    const excerpt = failed.locator('pre.pipeline-check-excerpt');
    await expect(excerpt).toContainText('FAIL internal/api');
    await expect(excerpt).toContainText('<img src=x onerror=alert(1)>');
    await expect(excerpt.locator('img')).toHaveCount(0);

    const passed = dialog.locator('.pipeline-check', { hasText: 'build' });
    await expect(passed.getByText('42s')).toBeVisible();
    await expect(passed.locator('pre')).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a failing GitHub pull request offers "Rerun failed checks", which posts for that pull request and shows a queued state', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ ci: 'failure' }));
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '', required: true }],
    });
    let posted: unknown = null;
    await page.route('**/api/pull-requests/rerun-checks', async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({ status: 204 });
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();

    await expect(dialog.getByRole('status')).toContainText('Rerun queued');
    expect(posted).toEqual({
      forge: 'github',
      fullName: 'alrayyes/forge-dashboard',
      number: 42,
    });
    await expect(
      dialog.getByRole('button', { name: 'Rerun queued' }),
    ).toBeDisabled();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a queued rerun stays held as "Rerun queued" when the panel is closed and reopened (#1941)', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ ci: 'failure' }));
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '', required: true }],
    });
    let posts = 0;
    await page.route('**/api/pull-requests/rerun-checks', async (route) => {
      posts += 1;
      await route.fulfill({ status: 204 });
    });
    await page.goto('/pull-requests.html');

    const open = () =>
      page
        .locator('#pr-rows .row')
        .first()
        .getByRole('button', { name: 'Open pipeline' })
        .click();
    await open();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(dialog.getByRole('status')).toContainText('Rerun queued');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await open();

    const held = dialog.getByRole('button', { name: 'Rerun queued' });
    await expect(held).toBeVisible();
    await expect(held).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toHaveCount(0);
    expect(posts).toBe(1);
  });

  test('a rerun still in flight stays held when the panel is reopened, so it is sent once (#1941)', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ ci: 'failure' }));
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '', required: true }],
    });
    let posts = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/pull-requests/rerun-checks', async (route) => {
      posts += 1;
      await gate;
      await route.fulfill({ status: 204 });
    });
    await page.goto('/pull-requests.html');

    const open = () =>
      page
        .locator('#pr-rows .row')
        .first()
        .getByRole('button', { name: 'Open pipeline' })
        .click();
    await open();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(dialog.getByRole('status')).toContainText('Queuing');

    await page.keyboard.press('Escape');
    await open();
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeDisabled();
    expect(posts).toBe(1);
    release();
  });

  test('a refused rerun is not held: reopening the panel offers the button again (#1941)', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ ci: 'failure' }));
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '', required: true }],
    });
    await page.route('**/api/pull-requests/rerun-checks', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'permission',
          message: 'Missing permission',
        }),
      }),
    );
    await page.goto('/pull-requests.html');

    const open = () =>
      page
        .locator('#pr-rows .row')
        .first()
        .getByRole('button', { name: 'Open pipeline' })
        .click();
    await open();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();

    await page.keyboard.press('Escape');
    await open();

    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeEnabled();
  });

  test('a failing Forgejo pull request offers "Rerun failed checks" too, and a pull request with nothing to rerun shows the forge reason', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      'forgejo',
      makePR({ forge: 'forgejo', repo: 'alrayyes/dotfiles', ci: 'failure' }),
    );
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '', required: true }],
    });
    let posted: unknown = null;
    let answer = 204;
    await page.route('**/api/pull-requests/rerun-checks', async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill(
        answer === 204
          ? { status: 204 }
          : {
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                error: 'raw',
                code: 'conflict',
                message: 'no failed job to rerun on this pull request',
              }),
            },
      );
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const rerun = dialog.getByRole('button', { name: 'Rerun failed checks' });

    answer = 409;
    await rerun.click();
    await expect(
      dialog.getByText('no failed job to rerun on this pull request'),
    ).toBeVisible();
    await expect(rerun).toBeEnabled();

    answer = 204;
    await rerun.click();
    await expect(dialog.getByRole('status')).toContainText('Rerun queued');
    expect(posted).toEqual({
      forge: 'forgejo',
      fullName: 'alrayyes/dotfiles',
      number: 42,
    });
    // The 'Rerun queued' panel is scanned in the GitHub test above: same markup.
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the panel showing the forge's "no failed job to rerun" reason has no axe-core violations in ${theme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await mockDashboard(
        page,
        'forgejo',
        makePR({ forge: 'forgejo', repo: 'alrayyes/dotfiles', ci: 'failure' }),
      );
      await mockChecks(page, {
        checks: [{ name: 'test', state: 'failure', url: '', required: true }],
      });
      await page.route('**/api/pull-requests/rerun-checks', (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'raw',
            code: 'conflict',
            message: 'no failed job to rerun on this pull request',
          }),
        }),
      );
      await page.goto('/pull-requests.html');

      await page
        .locator('#pr-rows .row')
        .first()
        .getByRole('button', { name: 'Open pipeline' })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
      await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
      await expect(
        dialog.getByText('no failed job to rerun on this pull request'),
      ).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('a refused rerun shows the reason in the panel and leaves the button to try again', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ ci: 'failure' }));
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '' }],
    });
    await page.route('**/api/pull-requests/rerun-checks', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'raw',
          code: 'permission',
          message: "The token can't write to Actions on this repo.",
        }),
      }),
    );
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();

    await expect(dialog.getByRole('alert')).toContainText(
      "The token can't write to Actions on this repo.",
    );
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeEnabled();
  });

  test('no "Rerun failed checks" where the server does not offer it', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      'forgejo',
      makePR({ forge: 'forgejo', ci: 'failure', allowedActions: [] }),
    );
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '' }],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await expect(dialog.getByText('Failed').first()).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toHaveCount(0);
  });

  test('the grouped panel has no axe-core violations and Escape still closes it', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://example.com/1',
          required: true,
        },
        {
          name: 'lint',
          state: 'failure',
          url: 'https://example.com/2',
          required: true,
        },
        {
          name: 'codecov',
          state: 'success',
          url: 'https://example.com/3',
          required: false,
        },
      ],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(
      dialog.getByRole('group', { name: /^Required/ }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('at phone width the grouped panel is a bottom sheet, traps focus and has no axe-core violations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        {
          name: 'build',
          state: 'success',
          url: 'https://example.com/1',
          required: true,
        },
        {
          name: 'codecov',
          state: 'success',
          url: 'https://example.com/2',
          required: false,
        },
      ],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(
      dialog.getByRole('group', { name: /^Required/ }),
    ).toBeVisible();

    const box = await dialog.boundingBox();
    if (!box) throw new Error('dialog has no bounding box');
    // Anchored to the bottom edge, full width.
    expect(Math.round(box.y + box.height)).toBe(800);
    expect(Math.round(box.width)).toBe(390);

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => {
          // A modal dialog makes the page behind it inert: focus is in
          // the dialog, or has left the document for the browser's own
          // chrome (body), never on a page element behind it.
          const active = document.activeElement;
          return (
            active === document.body || !!active?.closest('#pipeline-dialog')
          );
        }),
      ).toBe(true);
    }

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a failed fetch shows an error and a Retry that re-fetches', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    let attempts = 0;
    await page.route('**/api/pull-requests/checks*', (route: Route) => {
      attempts += 1;
      if (attempts === 1) {
        return route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'github: unreachable' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checks: [
            { name: 'build', state: 'success', url: 'https://example.com/1' },
          ],
        }),
      });
    });
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Open pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toContainText(/unreachable/i);
    // The dialog carries the error; the top banner is for global conditions.
    await expect(page.locator('#error-banner')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Retry' }).click();
    await expect(dialog.locator('.pipeline-check')).toHaveCount(1);
  });

  test('Escape closes the panel and returns focus to the row button', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, { checks: [] });
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    // #636: View pipeline is a plain inline row button — closing the dialog
    // rebuilds the row (same as every other row action already does) and
    // refocuses this same button by its stable id.
    const viewPipeline = row.getByRole('button', { name: 'Open pipeline' });
    await viewPipeline.click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(viewPipeline).toBeFocused();
  });

  test('the close button closes the panel', async ({ page }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, { checks: [] });
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Open pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await dialog.getByRole('button', { name: 'Close pipeline checks' }).click();
    await expect(dialog).toBeHidden();
  });

  test('the open panel is reachable by keyboard', async ({ page }) => {
    await mockDashboard(page, 'github', makePR());
    await mockChecks(page, {
      checks: [
        { name: 'build', state: 'success', url: 'https://example.com/1' },
        { name: 'test', state: 'failure', url: 'https://example.com/2' },
      ],
    });
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Open pipeline' }).click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog).toBeVisible();

    // Axe scans the same list in the grouped-panel test; this one is about
    // where focus goes: onto Close when the panel opens, then to the first
    // check's link. Waiting for the first keeps Tab from racing it.
    await expect(
      dialog.getByRole('button', { name: 'Close pipeline checks' }),
    ).toBeFocused();
    const firstLink = dialog.getByRole('link', { name: 'View run: build' });
    await expect(firstLink).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(firstLink).toBeFocused();
  });
});

// A queued rerun is held until the pull request moves on or ten minutes pass,
// and the row, the details dialog and the panel all read the one state (#1941).
test.describe('the held rerun: release, expiry and shared state (#1941)', () => {
  const withRerun = (overrides: Partial<MockPR> = {}) =>
    makePR({
      ci: 'failure',
      allowedActions: [{ action: 'rerun_checks' }],
      ...overrides,
    });

  async function setup(
    page: Page,
    opts: { fakeClock?: boolean; refuse?: boolean } = {},
  ) {
    const served = { pr: withRerun() };
    const posts = { count: 0 };
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    const snapshot = () =>
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [served.pr],
        issues: [],
      });
    for (const glob of ['**/api/dashboard*', '**/api/dashboard/refresh*'])
      await page.route(glob, (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: snapshot(),
        }),
      );
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '', required: true }],
    });
    await page.route('**/api/pull-requests/details*', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{}',
      }),
    );
    await page.route('**/api/pull-requests/rerun-checks', (route) => {
      posts.count += 1;
      return opts.refuse
        ? route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'permission',
              message: 'Missing permission',
            }),
          })
        : route.fulfill({ status: 204 });
    });
    if (opts.fakeClock) await page.clock.install();
    await page.goto('/pull-requests.html');
    return { served, posts };
  }

  const row = (page: Page) => page.locator('#pr-rows .row').first();
  const panel = (page: Page) =>
    page.getByRole('dialog', { name: 'Pipeline checks' });
  const openPanel = async (page: Page) => {
    await row(page).getByRole('button', { name: 'Open pipeline' }).click();
    return panel(page);
  };
  const queueFromPanel = async (page: Page) => {
    const dialog = await openPanel(page);
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(dialog.getByRole('status')).toContainText('Rerun queued');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
  const refresh = async (page: Page) => {
    await page.click('#force-refresh-button');
    await expect(page.locator('#force-refresh-button')).toBeEnabled();
  };

  test('the hold is released once the pull request stops reading failed', async ({
    page,
  }) => {
    const { served } = await setup(page);
    await queueFromPanel(page);

    served.pr = withRerun({ ci: 'pending' });
    await refresh(page);
    served.pr = withRerun({ ci: 'failure' });
    await refresh(page);

    const dialog = await openPanel(page);
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeEnabled();
  });

  test('the hold is released when the pull request is updated by a new commit', async ({
    page,
  }) => {
    const { served } = await setup(page);
    await queueFromPanel(page);

    served.pr = withRerun({
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await refresh(page);

    const dialog = await openPanel(page);
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeEnabled();
  });

  test('a snapshot that still reads failed keeps the hold', async ({
    page,
  }) => {
    const { posts } = await setup(page);
    await queueFromPanel(page);
    await refresh(page);

    const dialog = await openPanel(page);
    await expect(
      dialog.getByRole('button', { name: 'Rerun queued' }),
    ).toBeDisabled();
    expect(posts.count).toBe(1);
  });

  test('the hold expires after ten minutes', async ({ page }) => {
    await setup(page, { fakeClock: true });
    await queueFromPanel(page);

    let dialog = await openPanel(page);
    await expect(
      dialog.getByRole('button', { name: 'Rerun queued' }),
    ).toBeDisabled();
    await page.keyboard.press('Escape');

    await page.clock.fastForward(10 * 60 * 1000 + 1000);

    dialog = await openPanel(page);
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeEnabled();
  });

  test('a rerun queued from the panel reads as queued on the row and in the details dialog', async ({
    page,
  }) => {
    await setup(page);
    await queueFromPanel(page);

    const details = await openActionsDialog(row(page));
    const held = actionsFooter(details).getByRole('button', {
      name: 'Rerun queued',
    });
    await expect(held).toBeVisible();
    await expect(held).toHaveAttribute('aria-disabled', 'true');
    await closeActionsDialog(details);
  });

  test('a rerun the forge refused from the panel leaves the failure line in the details dialog', async ({
    page,
  }) => {
    await setup(page, { refuse: true });
    const dialog = await openPanel(page);
    await dialog.getByRole('button', { name: 'Rerun failed checks' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Missing permission');
    await page.keyboard.press('Escape');

    const details = await openActionsDialog(row(page));
    await expect(actionsFeedback(details)).toContainText(
      "couldn't rerun the checks",
    );
  });

  test('the pending panel button keeps focus and stays reachable by Tab', async ({
    page,
  }) => {
    await setup(page);
    const dialog = await openPanel(page);
    const button = dialog.getByRole('button', { name: 'Rerun failed checks' });
    await button.focus();
    await page.keyboard.press('Enter');
    const held = dialog.getByRole('button', { name: 'Rerun queued' });
    await expect(held).toHaveAttribute('aria-disabled', 'true');
    await expect(held).toBeFocused();

    await page.keyboard.press('Escape');
    const again = await openPanel(page);
    const reopened = again.getByRole('button', { name: 'Rerun queued' });
    await reopened.focus();
    await expect(reopened).toBeFocused();
  });
});
