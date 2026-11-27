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

async function open(page: Page, width: number) {
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
        pullRequests: [pr],
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
    // Anchored: "Cancel auto-merge" has the word in it.
    await expect(row(page).getByRole('button', { name: /^Merge/ })).toHaveCount(
      0,
    );
    await expect(row(page).locator('.row-action-locked')).toHaveCount(0);
    await expect(row(page).locator('.row-action-note')).toHaveCount(0);
    // Said once, inside the status cell where the stopped state is: printed on
    // the phone card, and in the chip's tooltip on a wider one (#4971).
    const cell = row(page).locator('.status-cell');
    const said = cell
      .locator(width === 390 ? '.auto-merge-blocked' : '.wait-chip-tip')
      .filter({ hasText: REASON });
    await expect(said).toHaveCount(1);
    if (width === 390) await expect(said).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('at 1280px the stopped chip says "Stopped" and describes why', async ({
  page,
}) => {
  await open(page, 1280);
  const chip = row(page).locator('.wait-chip');
  await expect(chip.locator('.wait-chip-label')).toHaveText('Stopped');
  await expect(chip).toHaveAccessibleDescription(new RegExp(REASON));
});
