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

for (const width of [1700, 1970]) {
  test.describe(`armed row with Update branch at ${width}px (#4784)`, () => {
    test('Update branch and the Auto-merge chip share a line and the row is as tall as a plain one', async ({
      page,
    }) => {
      await open(page, width);
      const rows = page.locator('#pr-rows > .row');
      const update = rows
        .nth(1)
        .getByRole('button', { name: 'Update branch', exact: true });
      await expect(update).toBeVisible();
      const chip = rows.nth(1).locator('.wait-chip');
      const u = (await update.boundingBox())!;
      const c = (await chip.boundingBox())!;
      expect(Math.abs(u.y + u.height / 2 - (c.y + c.height / 2))).toBeLessThan(
        4,
      );
      const plain = (await rows.nth(0).boundingBox())!.height;
      const armed = (await rows.nth(1).boundingBox())!.height;
      expect(armed).toBeLessThanOrEqual(plain + 2);
    });
  });
}

test.describe('armed row with Update branch below 94rem of list width (#4784)', () => {
  test('the chip keeps a line of its own, so the title keeps its width, and the row is one line taller at most', async ({
    page,
  }) => {
    await open(page, 1280);
    const rows = page.locator('#pr-rows > .row');
    const u = (await rows
      .nth(1)
      .getByRole('button', { name: 'Update branch', exact: true })
      .boundingBox())!;
    const c = (await rows.nth(1).locator('.wait-chip').boundingBox())!;
    expect(c.y).toBeGreaterThan(u.y + u.height - 4);
    const plain = (await rows.nth(0).boundingBox())!.height;
    const armed = (await rows.nth(1).boundingBox())!.height;
    expect(armed).toBeLessThanOrEqual(plain + 40);
  });
});
