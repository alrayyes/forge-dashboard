import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import {
  actionsFeedback,
  actionsFooter,
  closeActionsDialog,
  openActionsDialog,
} from './actions-dialog-helper';
import { checkLinkName } from './check-link-name-helper';
import { serveChecks } from './checks-feed-helper';
import { closeStream } from './fake-stream-helper';
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

function mockDashboard(
  page: Page,
  forge: string,
  pr?: MockPR,
  health: Record<string, unknown> = {},
) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge, reachable: true, repoCount: 1, ...health }],
        pullRequests: pr ? [pr] : [],
        issues: [],
      }),
    }),
  );
}

async function mockChecks(
  page: Page,
  body: { checks?: unknown[]; error?: string },
) {
  return await serveChecks(page, () =>
    body.error === undefined ? (body.checks ?? []) : { error: body.error },
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
    const { asked } = await mockChecks(page, {
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

    const buildLink = dialog.getByRole('link', {
      name: checkLinkName('View run', 'build'),
    });
    await expect(buildLink).toHaveAttribute(
      'href',
      'https://github.com/alrayyes/forge-dashboard/runs/1',
    );
    await expect(buildLink).toHaveAttribute('target', '_blank');
    await expect(buildLink).toHaveAttribute('rel', 'noopener');

    expect(asked).toEqual([
      {
        kind: 'pull_request',
        forge: 'github',
        fullName: 'alrayyes/forge-dashboard',
        number: 42,
      },
    ]);
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
      dialog.getByRole('link', {
        name: checkLinkName('View run', 'build'),
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('link', {
        name: checkLinkName('View run', 'deploy'),
      }),
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
      dialog.getByRole('link', {
        name: checkLinkName('View run', 'build'),
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('link', {
        name: checkLinkName('View run', 'legacy-ci'),
      }),
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
          startedAt: '2026-10-03T10:00:00Z',
          completedAt: '2026-10-03T10:02:05Z',
          failedStep: 'Run tests',
          excerpt: 'FAIL internal/api\n<img src=x onerror=alert(1)>',
        },
        {
          name: 'build',
          state: 'success',
          url: '',
          startedAt: '2026-10-03T10:00:00Z',
          completedAt: '2026-10-03T10:00:42Z',
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

  test('a failed Forgejo check shows at once and its log excerpt is filled in when it lands, announced politely', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      'forgejo',
      makePR({ forge: 'forgejo', repo: 'alrayyes/dotfiles', ci: 'failure' }),
    );
    await mockChecks(page, {
      checks: [
        {
          name: 'test',
          state: 'failure',
          url: 'https://example.com/7',
          jobId: 7,
          runAttempt: 1,
        },
        { name: 'build', state: 'success', url: '' },
      ],
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asked: string[] = [];
    await page.route('**/api/checks/log*', async (route) => {
      asked.push(route.request().url());
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          text: 'FAIL internal/api\n<img src=x onerror=alert(1)>',
          truncated: false,
        }),
      });
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const failed = dialog.locator('.pipeline-check', { hasText: 'test' });
    await expect(failed).toBeVisible();
    await expect(
      failed.getByRole('button', { name: 'View run: test' }),
    ).toBeVisible();
    await expect(failed.locator('pre.pipeline-check-excerpt')).toHaveCount(0);
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toContain('excerpt=true');
    expect(asked[0]).toContain('jobId=7');

    release();

    const excerpt = failed.locator('pre.pipeline-check-excerpt');
    await expect(excerpt).toContainText('FAIL internal/api');
    await expect(excerpt.locator('img')).toHaveCount(0);
    await expect(dialog.locator('.pipeline-live-status')).toHaveText(
      'Log excerpt loaded for test.',
    );
    expect(asked).toHaveLength(1);
  });

  test('a Forgejo log that was not flushed yet is asked for again and its excerpt appears when it lands', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      'forgejo',
      makePR({ forge: 'forgejo', repo: 'alrayyes/dotfiles', ci: 'failure' }),
    );
    await mockChecks(page, {
      checks: [
        {
          name: 'test',
          state: 'failure',
          url: 'https://example.com/7',
          jobId: 7,
          runAttempt: 1,
        },
      ],
    });
    const asked: string[] = [];
    await page.route('**/api/checks/log*', async (route) => {
      asked.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          text: asked.length === 1 ? '' : 'FAIL internal/api',
          truncated: false,
        }),
      });
    });
    await page.clock.install();
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    const failed = dialog.locator('.pipeline-check', { hasText: 'test' });
    await expect.poll(() => asked.length).toBe(1);
    await expect(failed.locator('pre.pipeline-check-excerpt')).toHaveCount(0);

    // The retry timer is set once the empty answer is handled, which may be
    // after the first request is seen, so advance the clock until it fires.
    await expect(async () => {
      await page.clock.runFor(15_000);
      expect(asked.length).toBeGreaterThanOrEqual(2);
    }).toPass();

    await expect(failed.locator('pre.pipeline-check-excerpt')).toContainText(
      'FAIL internal/api',
    );
    expect(asked).toHaveLength(2);
  });

  test('a GitHub check that carries no excerpt is not asked for one', async ({
    page,
  }) => {
    await mockDashboard(page, 'github', makePR({ ci: 'failure' }));
    await mockChecks(page, {
      checks: [
        { name: 'test', state: 'failure', url: 'https://x/1', jobId: 9 },
      ],
    });
    let asked = 0;
    await page.route('**/api/checks/log*', async (route) => {
      asked++;
      await route.fulfill({ status: 404, body: '{}' });
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.locator('.pipeline-check')).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(asked).toBe(0);
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

  test('a Forgejo with no rerun route offers no "Rerun failed checks" in the panel, only the reason', async ({
    page,
  }) => {
    const reason =
      'This Forgejo is older than version 17 and has no way to rerun checks. Rerun them on the forge.';
    await mockDashboard(
      page,
      'forgejo',
      makePR({ forge: 'forgejo', ci: 'failure' }),
      {
        rerunChecksBlocked: reason,
      },
    );
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '', required: true }],
    });
    await page.goto('/pull-requests.html');

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await expect(dialog.getByRole('status')).toContainText(reason);
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toHaveCount(0);
  });

  test('the panel swaps its button for the reason when the version read lands after it opened', async ({
    page,
  }) => {
    const reason =
      'This Forgejo is older than version 17 and has no way to rerun checks. Rerun them on the forge.';
    const health: Record<string, unknown> = {};
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [
            { forge: 'forgejo', reachable: true, repoCount: 1, ...health },
          ],
          pullRequests: [makePR({ forge: 'forgejo', ci: 'failure' })],
          issues: [],
        }),
      }),
    );
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '', required: true }],
    });
    await page.clock.install();
    await page.goto('/pull-requests.html');
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toBeVisible();

    health.rerunChecksBlocked = reason;
    await expect(async () => {
      await page.clock.runFor(60_000);
      await expect(dialog.getByRole('status')).toContainText(reason, {
        timeout: 500,
      });
    }).toPass();

    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toHaveCount(0);
  });

  test('the panel offers no rerun while the forge is unreachable, like the row', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      'forgejo',
      makePR({ forge: 'forgejo', ci: 'failure' }),
      { reachable: false },
    );
    await mockChecks(page, {
      checks: [{ name: 'test', state: 'failure', url: '', required: true }],
    });
    await page.goto('/pull-requests.html');
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await expect(dialog.getByRole('list')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Rerun failed checks' }),
    ).toHaveCount(0);
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
    await serveChecks(page, (_, call) =>
      call === 1
        ? { error: 'github: unreachable' }
        : [{ name: 'build', state: 'success', url: 'https://example.com/1' }],
    );
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

  test('a closed stream shows the error and a Retry, then the list once it is back', async ({
    page,
  }) => {
    await page.clock.install();
    await mockDashboard(page, 'github', makePR());
    await serveChecks(page, () => [
      { name: 'build', state: 'success', url: 'https://example.com/1' },
    ]);
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    const open = row.getByRole('button', { name: 'Open pipeline' });
    // The stream opens with the first snapshot.
    await expect(open).toBeVisible();
    await page.clock.pauseAt(new Date(Date.now() + 60000));
    await closeStream(page);
    await open.click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.getByRole('alert')).toContainText(
      /connection is down/i,
    );
    await expect(dialog.getByText('Loading checks')).toHaveCount(0);

    // With nothing to ask, Retry says so rather than spinning.
    await dialog.getByRole('button', { name: 'Retry' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/no answer/i);

    // The page opens the stream again; the watch goes out with it.
    await page.clock.runFor(3000);
    await expect(dialog.locator('.pipeline-check')).toHaveCount(1);
  });

  test('a stream that never connects stops the spinner and offers a Retry', async ({
    page,
  }) => {
    // The beforeEach aborts the real stream, so the browser keeps retrying it:
    // connecting, never closed.
    await page.clock.install();
    await mockDashboard(page, 'github', makePR());
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Open pipeline' }).click();

    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
    await expect(dialog.getByText('Loading checks')).toBeVisible();
    await page.clock.runFor(10000);
    await expect(dialog.getByRole('alert')).toContainText(/no answer/i);
    await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(dialog.getByText('Loading checks')).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
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
    const firstLink = dialog.getByRole('link', {
      name: checkLinkName('View run', 'build'),
    });
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
