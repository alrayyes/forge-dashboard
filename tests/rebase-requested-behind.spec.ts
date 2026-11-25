import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { forgeHealth } from './forge-health-helper';
import { quickPill } from './quick-pills-helper';
import { test } from './server-fixture';

// A Dependabot pull request whose rebase was just requested shows "Rebase
// requested" and nothing that tells the reader to do what the request already
// did: no Out of date chip and no "Behind the base branch" block. A request
// that timed out, or none, brings both back. The pop-up footer still lists
// Merge locked with its reason, and the Out of date quick filter reads
// `behind` as before.
// https://github.com/alrayyes/forge-dashboard/issues/4022

const BEHIND_STATUS = {
  code: 'behind',
  message: 'Behind the base branch',
  next: 'Bring it up to date to unlock Merge',
  action: 'dependabot_rebase',
};

const ALLOWED = [
  {
    action: 'merge',
    blocked: {
      code: 'behind',
      message: 'Behind the base branch',
      next: 'Bring it up to date to unlock Merge',
    },
  },
  { action: 'dependabot_rebase', primary: true },
  { action: 'close' },
];

function request(
  phase: 'queued' | 'rebasing' | 'expired',
  bot: 'dependabot' | 'renovate' = 'dependabot',
) {
  const requestedAt = Date.now() - (phase === 'expired' ? 20 * 60_000 : 1_000);
  return {
    bot,
    action: 'rebase',
    phase,
    requestedAt: new Date(requestedAt).toISOString(),
    expiresAt: new Date(requestedAt + 10 * 60_000).toISOString(),
    acknowledgedAt: new Date(requestedAt + 500).toISOString(),
  };
}

function pr(
  number: number,
  title: string,
  botRequest?: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.com/pull/${number}`,
    author: 'dependabot[bot]',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    kind: 'dependency',
    status: BEHIND_STATUS,
    allowedActions: ALLOWED,
    botRequest,
    ...extra,
  };
}

const MERGE_FIRST = [
  { ...ALLOWED[0], primary: true },
  { action: 'dependabot_rebase' },
  { action: 'close' },
];

const PRS = [
  pr(1, 'Requested rebase', request('queued')),
  pr(2, 'Timed out rebase', request('expired')),
  pr(3, 'No rebase asked'),
  pr(5, 'Picked up rebase', request('rebasing')),
  pr(6, 'Renovate rebase', request('queued', 'renovate'), {
    author: 'renovate[bot]',
    allowedActions: [
      { action: 'cancel_renovate_rebase', primary: true },
      ALLOWED[0],
      { action: 'close' },
    ],
  }),
  pr(
    8,
    'Requested recreate',
    { ...request('queued'), action: 'recreate' },
    {
      allowedActions: [{ action: 'close' }],
    },
  ),
  pr(7, 'Merge first', request('queued'), { allowedActions: MERGE_FIRST }),
  { ...pr(4, 'Up to date'), behind: false, status: undefined },
];

async function open(page: Page, width: number, path = '/bots.html') {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: PRS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

for (const width of [360, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, width);
    });

    test('a requested rebase shows only the wait chip', async ({ page }) => {
      const r = row(page, 'Requested rebase');
      await expect(r.locator('.wait-chip')).toContainText('Rebase requested');
      await expect(r.locator('.attr-chip.behind')).toHaveCount(0);
      await expect(r.locator('.status-area')).toHaveCount(0);
      await expect(r).not.toContainText('Behind the base branch');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });

    test('the requested row draws no Rebase requested button', async ({
      page,
    }) => {
      const r = row(page, 'Requested rebase');
      await expect(r.getByRole('button', { name: /requested/ })).toHaveCount(0);
      await expect(r.locator('.wait-chip')).toContainText('Rebase requested');
      await expect(r.getByText('Rebase requested')).toHaveCount(1);
    });

    test('a requested Recreate says Recreate requested once', async ({
      page,
    }) => {
      const r = row(page, 'Requested recreate');
      await expect(r.locator('.wait-chip')).toContainText('Recreate requested');
      await expect(r.getByText('Recreate requested')).toHaveCount(1);
      await expect(r.getByRole('button', { name: /requested/ })).toHaveCount(0);
    });

    test('a picked up rebase hides the pill and block too', async ({
      page,
    }) => {
      const r = row(page, 'Picked up rebase');
      await expect(r.locator('.wait-chip')).toBeVisible();
      await expect(r.locator('.attr-chip.behind')).toHaveCount(0);
      await expect(r.locator('.status-area')).toHaveCount(0);
    });

    test('a pending Renovate rebase hides the pill and block too', async ({
      page,
    }) => {
      const r = row(page, 'Renovate rebase');
      await expect(r.locator('.wait-chip')).toBeVisible();
      await expect(r.locator('.attr-chip.behind')).toHaveCount(0);
      await expect(r.locator('.status-area')).toHaveCount(0);
    });

    test('a locked Merge on the requested row prints its own reason', async ({
      page,
    }) => {
      const r = row(page, 'Merge first');
      await expect(r.locator('.status-area')).toHaveCount(0);
      const merge = r.getByRole('button', { name: 'Merge', exact: true });
      await expect(merge).toHaveAttribute('aria-disabled', 'true');
      await expect(r.locator('.row-action-locked')).toContainText(
        'Bring it up to date to unlock Merge',
      );
      const id = await merge.getAttribute('aria-describedby');
      if (id) await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
      await expect(merge).toHaveAccessibleDescription(/Bring it up to date/);
    });

    test('a timed out request brings the chip and message back', async ({
      page,
    }) => {
      const r = row(page, 'Timed out rebase');
      await expect(r.locator('.attr-chip.behind')).toHaveText(/Out of date/);
      await expect(r.locator('.status-area')).toContainText(
        'Behind the base branch',
      );
    });

    test('with no request the row is as it was', async ({ page }) => {
      const r = row(page, 'No rebase asked');
      await expect(r.locator('.attr-chip.behind')).toHaveText(/Out of date/);
      await expect(r.locator('.status-area')).toContainText(
        'Behind the base branch',
      );
    });
  });
}

test('the Out of date quick filter keeps the requested row', async ({
  page,
}) => {
  await open(page, 1280);
  await quickPill(page, 'Out of date').click();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(7);
  await expect(row(page, 'Requested rebase')).toHaveCount(1);
});

test('the pop-up footer lists Merge locked with its reason', async ({
  page,
}) => {
  await open(page, 1280);
  const dialog = await openActionsDialog(row(page, 'Requested rebase'));
  await expect(
    actionsFooter(dialog).getByRole('button', { name: 'Merge', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  await expect(dialog.locator('.status-area')).toContainText(
    'Behind the base branch',
  );
});

test('the pop-up lists the requested rebase as locked with its reason', async ({
  page,
}) => {
  await open(page, 1280);
  const dialog = await openActionsDialog(row(page, 'Requested rebase'));
  const locked = actionsFooter(dialog).getByRole('button', {
    name: 'Rebase requested',
  });
  await expect(locked).toHaveAttribute('aria-disabled', 'true');
  await expect(locked).toHaveAccessibleDescription(/No need to ask again/);
});

for (const width of [390, 1280]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`axe is clean on requested rows at ${width}px, ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await open(page, width);
      await expect(row(page, 'Requested recreate')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
