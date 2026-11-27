import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #4944: a failing-CI row whose auto-merge stopped draws no Merge button. The
// reason Merge is blocked joins the stopped state in the right-hand action
// area (the chip's detail line, or the phone card's text line), and the left
// shows the title and labels only.

const REASON = 'Blocked, CI is failing';

const pr = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 42,
  title: 'chore(deps): bump a library',
  url: 'https://example.com/42',
  author: 'claude',
  draft: false,
  ci: 'failure',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mergeStatus: 'blocked',
  behind: false,
  autoMergeEnabled: true,
  autoMerge: {
    state: 'stopped',
    code: 'checks_failing',
    message: 'Auto-merge stopped: a check failed.',
  },
  allowedActions: [
    {
      action: 'merge',
      blocked: { code: 'checks_failing', message: REASON, next: '' },
    },
    { action: 'close' },
    { action: 'cancel_auto_merge' },
  ],
};

async function open(page: Page, width: number, mock: object = pr) {
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
        pullRequests: [mock],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
}

const row = (page: Page) => page.locator('#pr-rows > .row').first();

for (const width of [390, 1280]) {
  test(`at ${width}px the row has no Merge button and says the reason once, in the action area`, async ({
    page,
  }) => {
    await open(page, width);
    await expect(row(page).getByRole('button', { name: 'Merge' })).toHaveCount(
      0,
    );
    await expect(row(page).locator('.row-action-locked')).toHaveCount(0);
    await expect(row(page).locator('.row-action-note')).toHaveCount(0);
    // Said once, readable without hovering, and inside the status cell where
    // the stopped state is.
    const reason = row(page)
      .locator('.status-cell')
      .locator('.auto-merge-blocked, .wait-chip-detail')
      .filter({ hasText: REASON })
      .filter({ visible: true });
    await expect(reason).toHaveCount(1);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('at 1280px the reason is in the stopped chip, next to its words', async ({
  page,
}) => {
  await open(page, 1280);
  const chip = row(page).locator('.wait-chip');
  await expect(chip.locator('.wait-chip-label')).toHaveText(
    'Auto-merge stopped',
  );
  await expect(chip.locator('.wait-chip-detail')).toHaveText(REASON);
});

// #5088: the server's status block says the same words as the stopped state, so
// the row draws only one of them. Counted across the whole row, with the
// `status` the server sends for a blocked Merge.
const status = { code: 'checks_failing', message: REASON, next: '' };
const stopped = { ...pr, status };
const unarmed = {
  ...stopped,
  autoMergeEnabled: false,
  autoMerge: undefined,
  allowedActions: pr.allowedActions.filter(
    (a) => a.action !== 'cancel_auto_merge',
  ),
};

for (const width of [390, 1280]) {
  for (const [name, mock] of [
    ['stopped auto-merge', stopped],
    ['no auto-merge', unarmed],
  ] as const) {
    test(`at ${width}px a failing row with ${name} says CI is failing once`, async ({
      page,
    }) => {
      await open(page, width, mock);
      await expect(
        row(page)
          .getByText(/CI is failing/)
          .filter({ visible: true }),
      ).toHaveCount(1);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
