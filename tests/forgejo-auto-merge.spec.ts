import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { viaActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

type AutoMergeStatus = {
  state: 'waiting' | 'stopped';
  code?: string;
  message: string;
};

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'forgejo',
    repo: 'alrayyes/dotfiles',
    number: 7,
    title: 'Add a chezmoi hook',
    url: 'https://example.com/7',
    author: 'claude',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    autoMergeEnabled: false,
    ...overrides,
  };
}

function snapshot(
  pr: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
    pullRequests: [pr],
    issues: [],
    ...extra,
  };
}

function mockDashboard(page: Page, body: unknown) {
  return page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

function armed(
  status: AutoMergeStatus,
  heldBy: 'dashboard' | 'forge' | null = 'dashboard',
) {
  return makePR({
    autoMergeEnabled: true,
    ...(heldBy ? { autoMergeHeldBy: heldBy } : {}),
    autoMerge: status,
    allowedActions: [
      { action: 'merge' },
      { action: 'close' },
      { action: 'cancel_auto_merge' },
    ],
  });
}

// Aborted, so a real snapshot can't be pushed over the mock.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
});

test.describe('Forgejo auto-merge on a pull request row', () => {
  test('a Forgejo pull request offers Enable auto-merge, which posts for that pull request', async ({
    page,
  }) => {
    await mockDashboard(page, snapshot(makePR()));
    let posted: unknown = null;
    await page.route('**/api/v1/pull-requests/auto-merge', (route: Route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/v1/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          snapshot(
            armed({
              state: 'waiting',
              message: 'Waiting for checks to finish.',
            }),
          ),
        ),
      }),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await viaActionsDialog(row, (footer) =>
      footer.getByRole('button', { name: 'Enable auto-merge' }).click(),
    );

    await expect(row.getByText('Waiting for checks to finish.')).toBeVisible();
    expect(posted).toEqual({
      forge: 'forgejo',
      fullName: 'alrayyes/dotfiles',
      number: 7,
    });
  });

  test('an armed pull request says in words that Forge Dashboard does the merging, and why it waits', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      snapshot(
        armed({
          state: 'waiting',
          code: 'checks_pending',
          message: 'Waiting for checks to finish.',
        }),
      ),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    // The wait chip is the one place the row says it is armed (#4686).
    await expect(row.locator('.attr-chip.auto-merge')).toHaveCount(0);
    // The waiting chip says it in a word, the server's sentence is its hint,
    // and Cancel auto-merge is inside it (#1229).
    const chip = row.locator('.wait-chip');
    await expect(chip.locator('.wait-chip-label')).toHaveText('Waiting for CI');
    await expect(chip.locator('.wait-chip-tip')).toHaveText(
      'Waiting for checks to finish.',
    );
    await expect(
      chip.getByRole('button', { name: 'Cancel auto-merge' }),
    ).toBeVisible();
  });

  test('a stopped pull request says it needs a person, in text', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      snapshot(
        armed({
          state: 'stopped',
          code: 'checks_failing',
          message: 'A check failed. Fix it and auto-merge carries on.',
        }),
      ),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    // On a desktop the words are a chip, its sentence the tooltip (#4601).
    const chip = row.locator('.wait-chip');
    await expect(chip.locator('.wait-chip-label')).toHaveText(
      'Auto-merge stopped',
    );
    await expect(chip.locator('.wait-chip-tip')).toHaveText(
      'A check failed. Fix it and auto-merge carries on.',
    );
    await expect(row.locator('.auto-merge-status')).toContainText('Stopped');
  });

  test('Cancel auto-merge posts for that pull request and the pill goes', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      snapshot(
        armed({
          state: 'waiting',
          code: 'checks_pending',
          message: 'Waiting for checks to finish.',
        }),
      ),
    );
    let posted: unknown = null;
    await page.route(
      '**/api/v1/pull-requests/auto-merge/cancel',
      (route: Route) => {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      },
    );
    await page.route('**/api/v1/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(makePR())),
      }),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Cancel auto-merge' }).click();

    await expect(row.locator('.attr-chip.auto-merge')).toHaveCount(0);
    expect(posted).toEqual({
      forge: 'forgejo',
      fullName: 'alrayyes/dotfiles',
      number: 7,
    });
  });

  test('a pull request the app auto-merged is announced once, as a toast', async ({
    page,
  }) => {
    const done = {
      autoMerged: [
        {
          forge: 'forgejo',
          fullName: 'alrayyes/dotfiles',
          number: 7,
          mergedAt: new Date().toISOString(),
          message: 'Auto-merged alrayyes/dotfiles#7 after checks passed',
        },
      ],
    };
    await mockDashboard(page, snapshot(makePR(), done));
    await page.route('**/api/v1/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(makePR(), done)),
      }),
    );
    await page.goto('/pull-requests.html');

    const toasts = page.locator('#feedback-toasts .feedback-toast');
    await expect(toasts).toHaveCount(1);
    await expect(toasts.first()).toContainText(
      'Auto-merged alrayyes/dotfiles#7 after checks passed',
    );

    // The same snapshot again, asked for by hand, must not toast it twice.
    const refreshed = page.waitForResponse('**/api/v1/dashboard/refresh*');
    await page.click('#force-refresh-button');
    await refreshed;
    await expect(toasts).not.toHaveCount(2);
  });

  // #1596: the wait chip's words say who holds the merge, as the server
  // names it, and say nothing about it when the server doesn't.
  for (const holder of ['dashboard', 'forge'] as const) {
    test(`a ${holder}-held auto-merge says who merges it in the wait chip`, async ({
      page,
    }) => {
      await mockDashboard(
        page,
        snapshot(
          armed({ state: 'waiting', code: '', message: 'Ready.' }, holder),
        ),
      );
      await page.goto('/pull-requests.html');
      const row = page.locator('#pr-rows .row').first();
      // The holder is told by the wait chip's detail below, not by an
      // attribute chip that would make the row taller (#4686).
      await expect(row.locator('.attr-chip.auto-merge')).toHaveCount(0);
      await expect(row.locator('.wait-chip-label')).toHaveText(
        holder === 'forge' ? 'Merging' : 'Merging next',
      );
      await expect(row.locator('.wait-chip-detail')).toHaveText(
        holder === 'forge'
          ? 'Forgejo merges it when checks pass'
          : 'On the next refresh',
      );
    });
  }

  test('an auto-merge with no named holder claims no ownership', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      snapshot(armed({ state: 'waiting', code: '', message: 'Ready.' }, null)),
    );
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    await expect(row.locator('.attr-chip.auto-merge')).toHaveCount(0);
    await expect(row.locator('.wait-chip-label')).toHaveText('Merging next');
  });

  test('Cancel on a forge-held auto-merge says it cancels the scheduled merge', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      snapshot(
        armed({ state: 'waiting', code: '', message: 'Ready.' }, 'forge'),
      ),
    );
    await page.route(
      '**/api/v1/pull-requests/auto-merge/cancel',
      (route: Route) => route.fulfill({ status: 204 }),
    );
    await page.route('**/api/v1/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(makePR())),
      }),
    );
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    // The visible word is the same everywhere; the name adds where the merge
    // is scheduled, and the hover text says what cancelling does.
    const cancel = row.getByRole('button', {
      name: 'Cancel auto-merge scheduled on Forgejo',
      exact: true,
    });
    await expect(cancel).toHaveText('Cancel auto-merge');
    await expect(cancel).toHaveAttribute(
      'title',
      'Cancels the merge scheduled on Forgejo.',
    );
    await cancel.click();
    await expect(
      page
        .getByText('Merge scheduled on Forgejo cancelled.')
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('an armed row has no axe-core violations', async ({ page }) => {
    await mockDashboard(
      page,
      snapshot(
        armed({
          state: 'stopped',
          code: 'conflict',
          message: 'Conflicts need fixing by hand.',
        }),
      ),
    );
    await page.goto('/pull-requests.html');
    await expect(
      page.locator('#pr-rows .row').first().locator('.attr-chip.auto-merge'),
    ).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

// Two repos, since the group control is not drawn over fewer (#3670, #4680).
const CALLOUT =
  'Auto-merge on Forgejo is handled by Forge Dashboard, not Forgejo itself.';

test.describe('Forgejo auto-merge explained where it is used', () => {
  test('a grouped Forgejo repo says who handles auto-merge and links to Settings', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      snapshot(makePR(), {
        pullRequests: [makePR(), makePR({ number: 8, repo: 'acme/other' })],
      }),
    );
    await page.goto('/pull-requests.html');
    await page.selectOption('#shared-group-select', 'repo');

    const callout = page.locator('#pr-rows .group-callout').first();
    await expect(callout).toContainText(CALLOUT);
    await expect(
      callout.getByRole('link', { name: 'Settings' }),
    ).toHaveAttribute('href', '/settings.html#forgejo-auto-merge');
  });

  test('a GitHub repo group has no such callout', async ({ page }) => {
    await mockDashboard(
      page,
      snapshot(makePR({ forge: 'github', repo: 'alrayyes/forge-dashboard' }), {
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [
          makePR({ forge: 'github', repo: 'alrayyes/forge-dashboard' }),
          makePR({ forge: 'github', repo: 'alrayyes/other', number: 8 }),
        ],
      }),
    );
    await page.goto('/pull-requests.html');
    await page.selectOption('#shared-group-select', 'repo');

    await expect(page.locator('#pr-rows > h3.group-heading')).toHaveCount(2);
    await expect(page.locator('#pr-rows .group-callout')).toHaveCount(0);
  });

  test('the callout has no axe-core violations', async ({ page }) => {
    await mockDashboard(
      page,
      snapshot(makePR(), {
        pullRequests: [makePR(), makePR({ number: 8, repo: 'acme/other' })],
      }),
    );
    await page.goto('/pull-requests.html');
    await page.selectOption('#shared-group-select', 'repo');
    await expect(page.locator('#pr-rows .group-callout').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('Settings explains Forgejo auto-merge in plain words, with no axe-core violations', async ({
    page,
  }) => {
    await page.goto('/settings.html#forgejo-auto-merge');

    const section = page.locator('#forgejo-auto-merge');
    await expect(
      section.getByRole('heading', { name: 'Forgejo auto-merge' }),
    ).toBeVisible();
    await expect(section).toContainText(CALLOUT);
    await expect(section).toContainText('Enable auto-merge');
    await expect(section).toContainText('Cancel auto-merge');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
