import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import fixture from './generated/behind-status.json';
import { test } from './server-fixture';

// A pull request with Update branch and an armed Auto-merge chip put the chip
// on a second line under the button, so its row was two lines tall while the
// rows around it were one. On a wide list the two now share a line; a
// narrower one keeps the chip on a line of its own so the title keeps its
// width (#4789). From 94rem of list width (1504px at the default text size)
// the row is one line, 55px; below it the chip is on a line of its own and the
// row is 89px, one 34px line more. The boundary is pinned both ways.
// https://github.com/alrayyes/forge-dashboard/issues/4784

const base = fixture.pullRequests.notStrict as Record<string, unknown>;

const LABELS = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'Refs #4784', color: 'ededed' },
];

const PLAIN = {
  ...base,
  labels: LABELS,
  number: 1,
  title: 'Plain',
  ci: 'success',
  autoMergeEnabled: false,
  autoMerge: null,
  behind: false,
  allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
};

// Behind, armed, and the checks still running: Update branch is offered
// beside the "Waiting for CI" chip.
const ARMED = {
  ...base,
  labels: LABELS,
  number: 2,
  title: 'Armed and behind',
  ci: 'running',
  checks: { ...(base.checks as object), passed: 23, running: 3 },
  autoMerge: {
    state: 'waiting',
    code: 'checks_pending',
    message: 'Auto-merge is waiting for the checks to finish.',
  },
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
        pullRequests: [PLAIN, ARMED],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
}

// #4942: the chip's label is the Update branch control, so an armed, behind
// row draws one chip where it drew a chip and a button. The row stays one line
// from a phone-wide list up, and Cancel auto-merge stays its own button.
const SWAP = 'Waiting for CI, update branch';

for (const width of [1280, 1700, 1970]) {
  test.describe(`armed row with Update branch at ${width}px (#4942)`, () => {
    test('the chip is the one control, and the row is as tall as a plain one', async ({
      page,
    }) => {
      await open(page, width);
      const rows = page.locator('#pr-rows > .row');
      const armed = rows.nth(1);
      await expect(armed.getByRole('button', { name: SWAP })).toBeVisible();
      await expect(
        armed.getByRole('button', { name: 'Update branch', exact: true }),
      ).toHaveCount(0);
      await expect(
        armed.getByRole('button', { name: 'Cancel auto-merge' }),
      ).toBeVisible();
      const plain = (await rows.nth(0).boundingBox())!.height;
      const height = (await armed.boundingBox())!.height;
      expect(height).toBeLessThanOrEqual(plain + 2);
    });
  });
}

test.describe('the shared slot is reachable without hover (#4942, #4531)', () => {
  test('Enter on the focused chip runs Update branch, and Cancel is the next Tab', async ({
    page,
  }) => {
    let updates = 0;
    await page.route('**/api/v1/pull-requests/update-branch', (route) => {
      updates++;
      return route.fulfill({ status: 202 });
    });
    await open(page, 1280);
    const armed = page.locator('#pr-rows > .row').nth(1);
    const swap = armed.getByRole('button', { name: SWAP });
    await swap.focus();
    await expect(armed.locator('.wait-chip-label')).toHaveText('Update branch');
    await page.keyboard.press('Tab');
    await expect(
      armed.getByRole('button', { name: 'Cancel auto-merge' }),
    ).toBeFocused();
    await swap.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => updates).toBe(1);
  });

  test('a first tap reveals Update branch and the second runs it', async ({
    page,
  }) => {
    let updates = 0;
    await page.route('**/api/v1/pull-requests/update-branch', (route) => {
      updates++;
      return route.fulfill({ status: 202 });
    });
    await open(page, 390);
    const armed = page.locator('#pr-rows > .row').nth(1);
    const swap = armed.getByRole('button', { name: SWAP });
    await swap.dispatchEvent('click', { detail: 1 });
    await expect(armed.locator('.wait-chip-label')).toHaveText('Update branch');
    expect(updates).toBe(0);
    await swap.dispatchEvent('click', { detail: 1 });
    await expect.poll(() => updates).toBe(1);
  });
});
