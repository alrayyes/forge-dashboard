import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { viaActionsDialog } from './actions-dialog-helper';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `forgejo-auto-merge-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Forgejo Auto-merge Test User',
  );
}

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
  return page.route('**/api/dashboard*', (route: Route) =>
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

// The pull request row tests mock the dashboard and write nothing per user, so
// they start from the shared session instead of registering a user per test
// (#1379).
test.describe('Forgejo auto-merge on a pull request row', () => {
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Aborted, so a real snapshot can't be pushed over the mock.
    await page.route('**/api/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
  });

  test('a Forgejo pull request offers Enable auto-merge, which posts for that pull request', async ({
    page,
  }) => {
    await mockDashboard(page, snapshot(makePR()));
    let posted: unknown = null;
    await page.route('**/api/pull-requests/auto-merge', (route: Route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/dashboard/refresh', (route: Route) =>
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
    const pill = row.locator('.attr-chip.auto-merge');
    await expect(pill).toContainText('Auto-merge on');
    await expect(pill).toContainText('Managed by Forge Dashboard');
    // The waiting chip says it in a word, the server's sentence is its hint,
    // and Disarm is inside it (#1229).
    const chip = row.locator('.wait-chip');
    await expect(chip.locator('.wait-chip-label')).toHaveText('Waiting for CI');
    await expect(chip.locator('.wait-chip-tip')).toHaveText(
      'Waiting for checks to finish.',
    );
    await expect(
      chip.getByRole('button', { name: 'Disarm auto-merge' }),
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
    await expect(
      row.getByText('A check failed. Fix it and auto-merge carries on.'),
    ).toBeVisible();
    await expect(row.locator('.auto-merge-status')).toContainText('Stopped');
  });

  test('Disarm posts for that pull request and the pill goes', async ({
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
      '**/api/pull-requests/auto-merge/cancel',
      (route: Route) => {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 204 });
      },
    );
    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(makePR())),
      }),
    );
    await page.goto('/pull-requests.html');

    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'Disarm auto-merge' }).click();

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
    await page.route('**/api/dashboard/refresh', (route: Route) =>
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
    const refreshed = page.waitForResponse('**/api/dashboard/refresh*');
    await page.click('#force-refresh-button');
    await refreshed;
    await expect(toasts).not.toHaveCount(2);
  });

  // #1596: the note and the words say who holds the merge, as the server
  // names it, and say nothing about it when the server doesn't.
  const HOLDERS = [
    ['dashboard', 'Managed by Forge Dashboard'],
    ['forge', 'Scheduled on Forgejo'],
  ] as const;

  for (const [holder, note] of HOLDERS) {
    test(`a ${holder}-held auto-merge says "${note}"`, async ({ page }) => {
      await mockDashboard(
        page,
        snapshot(
          armed({ state: 'waiting', code: '', message: 'Ready.' }, holder),
        ),
      );
      await page.goto('/pull-requests.html');
      const row = page.locator('#pr-rows .row').first();
      const pill = row.locator('.attr-chip.auto-merge');
      await expect(pill).toContainText('Auto-merge on');
      await expect(pill.locator('.pill-note')).toHaveText(note);
      const others = HOLDERS.filter(([h]) => h !== holder);
      for (const [, other] of others)
        await expect(pill).not.toContainText(other);
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
    const pill = row.locator('.attr-chip.auto-merge');
    await expect(pill).toContainText('Auto-merge on');
    await expect(pill.locator('.pill-note')).toHaveCount(0);
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
    await page.route('**/api/pull-requests/auto-merge/cancel', (route: Route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(makePR())),
      }),
    );
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    await row
      .getByRole('button', {
        name: 'Disarm the merge scheduled on Forgejo',
        exact: true,
      })
      .click();
    await expect(
      page
        .getByText('Merge scheduled on Forgejo cancelled.')
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  for (const width of [360, 768, 1280]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`the forge note stays inside the chip at ${width}px in ${theme} mode, with no axe-core violations`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 900 });
        await mockDashboard(
          page,
          snapshot(
            armed({ state: 'waiting', code: '', message: 'Ready.' }, 'forge'),
          ),
        );
        await page.goto('/pull-requests.html');
        const chip = page
          .locator('#pr-rows .row')
          .first()
          .locator('.attr-chip.auto-merge');
        await expect(chip.locator('.pill-note')).toHaveText(
          'Scheduled on Forgejo',
        );
        const fit = await chip.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const note = (
            el.querySelector('.pill-note') as HTMLElement
          ).getBoundingClientRect();
          return {
            inside:
              note.left >= box.left - 0.5 &&
              note.right <= box.right + 0.5 &&
              note.top >= box.top - 0.5 &&
              note.bottom <= box.bottom + 0.5,
            clipped: el.scrollWidth > el.clientWidth,
          };
        });
        expect(fit.inside).toBe(true);
        expect(fit.clipped).toBe(false);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }

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
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

const CALLOUT =
  'Auto-merge on Forgejo is handled by Forge Dashboard, not Forgejo itself.';

test.describe('Forgejo auto-merge explained where it is used', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('a grouped Forgejo repo says who handles auto-merge and links to Settings', async ({
    page,
  }) => {
    await mockDashboard(page, snapshot(makePR()));
    await page.reload();
    await page.selectOption('#shared-group-select', 'repo');

    const callout = page.locator('#pr-rows .group-callout');
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
      }),
    );
    await page.reload();
    await page.selectOption('#shared-group-select', 'repo');

    await expect(page.locator('#pr-rows > h3.group-heading')).toHaveCount(1);
    await expect(page.locator('#pr-rows .group-callout')).toHaveCount(0);
  });

  test('the callout has no axe-core violations', async ({ page }) => {
    await mockDashboard(page, snapshot(makePR()));
    await page.reload();
    await page.selectOption('#shared-group-select', 'repo');
    await expect(page.locator('#pr-rows .group-callout')).toBeVisible();

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
