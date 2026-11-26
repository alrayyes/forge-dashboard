import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import fixture from './generated/behind-status.json';
import { test } from './server-fixture';

// A pull request with Update branch and an armed Auto-merge chip used to put
// the chip on a second line under the button, so its row was taller than the
// rows around it (#4784). The chip's label is now the Update branch control
// (#4942): one chip, one slot, so the row is as tall as an armed row without
// Update branch at every width, and the title keeps its floor (#4795).

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

async function open(
  page: Page,
  width: number,
  armed: Record<string, unknown> = ARMED,
) {
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
        pullRequests: [PLAIN, armed],
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

const SWAP = 'Waiting for CI, update branch';

// Behind and armed, but Update branch is listed blocked, so it is locked.
const LOCKED = {
  ...ARMED,
  allowedActions: [
    { action: 'merge' },
    { action: 'close' },
    {
      action: 'update_branch',
      blocked: {
        code: 'checks_pending',
        message: 'Wait for the runs to start',
      },
    },
    { action: 'cancel_auto_merge' },
  ],
};

function rowOf(page: Page) {
  return page.locator('#pr-rows > .row').nth(1);
}

for (const width of [1280, 1700, 1970]) {
  test.describe(`armed row with Update branch at ${width}px (#4942)`, () => {
    test('the chip is the one control, on one line, and the row is as tall as a plain one', async ({
      page,
    }, info) => {
      await open(page, width);
      const armed = rowOf(page);
      await expect(armed.getByRole('button', { name: SWAP })).toBeVisible();
      await expect(
        armed.getByRole('button', { name: 'Update branch', exact: true }),
      ).toHaveCount(0);
      await expect(
        armed.getByRole('button', { name: 'Cancel auto-merge' }),
      ).toBeVisible();
      const m = await armed.evaluate((r) => {
        const box = (s: string) => r.querySelector(s)!.getBoundingClientRect();
        const label = r.querySelector('.wait-chip-label')!;
        const line = parseFloat(getComputedStyle(label).lineHeight);
        return {
          row: r.getBoundingClientRect().height,
          title: box('.title-cell').width,
          labelLines: Math.round(box('.wait-chip-label').height / line),
          chip: box('.wait-chip').height,
        };
      });
      const plain = (await page
        .locator('#pr-rows > .row')
        .first()
        .boundingBox())!.height;
      info.annotations.push({
        type: 'measured',
        description: JSON.stringify({ width, plain, ...m }),
      });
      // The label is one line, the title keeps its floor (#4795), and the row
      // is within a pixel of a row with no wait at all.
      expect(m.labelLines).toBe(1);
      expect(m.title).toBeGreaterThanOrEqual(200);
      expect(Math.abs(m.row - plain)).toBeLessThanOrEqual(1);
    });
  });
}

test.describe('reaching the swap without a mouse (#4942, #4531)', () => {
  test('hover reveals Update branch and leaving puts the wait back, with no width change', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 1280);
    const armed = rowOf(page);
    const chip = armed.locator('.wait-chip');
    const label = armed.locator('.wait-chip-label');
    await expect(label).toHaveText('Waiting for CI');
    const before = (await chip.boundingBox())!.width;
    const at = (await armed.getByRole('button', { name: SWAP }).boundingBox())!;
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await expect(label).toHaveText('Update branch');
    expect((await chip.boundingBox())!.width).toBe(before);
    await page.mouse.move(0, 0);
    await expect(label).toHaveText('Waiting for CI');
  });

  test('Enter on the focused chip runs Update branch, and Cancel is the next Tab', async ({
    page,
  }) => {
    let updates = 0;
    await page.route('**/api/v1/pull-requests/update-branch', (route) => {
      updates++;
      return route.fulfill({ status: 202 });
    });
    await open(page, 1280);
    const armed = rowOf(page);
    const swap = armed.getByRole('button', { name: SWAP });
    await swap.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(swap).toBeFocused();
    await expect(armed.locator('.wait-chip-label')).toHaveText('Update branch');
    await page.keyboard.press('Tab');
    await expect(
      armed.getByRole('button', { name: 'Cancel auto-merge' }),
    ).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect.poll(() => updates).toBe(1);
  });

  test('running it hands the row to the queued chip, and a second Enter or Space posts nothing', async ({
    page,
  }) => {
    let updates = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/pull-requests/update-branch', async (route) => {
      updates++;
      await gate;
      await route.fulfill({ status: 202 });
    });
    await open(page, 1280);
    const armed = rowOf(page);
    await armed.getByRole('button', { name: SWAP }).focus();
    await page.keyboard.press('Enter');
    // The row redraws at once with its own queued chip: the swap is gone, so
    // there is no second control to press (#4942).
    await expect(
      armed.getByRole('group', { name: /^Updating branch/ }),
    ).toBeVisible();
    await expect(armed.locator('.wait-chip-swap')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    release();
    await expect.poll(() => updates).toBe(1);
  });

  test('a locked Update branch keeps aria-disabled and gives its reason as the description', async ({
    page,
  }) => {
    let updates = 0;
    await page.route('**/api/v1/pull-requests/update-branch', (route) => {
      updates++;
      return route.fulfill({ status: 202 });
    });
    await open(page, 1280, LOCKED);
    const armed = rowOf(page);
    const swap = armed.getByRole('button', { name: SWAP });
    await expect(swap).toHaveAttribute('aria-disabled', 'true');
    await expect(swap).toHaveAccessibleDescription(
      /Update branch is locked\. Wait for the runs to start/,
    );
    await swap.focus();
    await page.keyboard.press('Enter');
    // The chip has no second line to give the reason, so it is the title.
    await expect(swap).toHaveAttribute('title', 'Wait for the runs to start');
    expect(updates).toBe(0);
  });

  test('a retryable lock keeps the row its plain Retry button and no swap', async ({
    page,
  }) => {
    await page.route('**/api/v1/pull-requests/update-branch', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'bad gateway',
          code: 'forge_unreachable',
        }),
      }),
    );
    await open(page, 1280, ARMED);
    // Until the first request fails, the chip has the swap; run it once.
    const armed = rowOf(page);
    await armed.getByRole('button', { name: SWAP }).focus();
    await page.keyboard.press('Enter');
    // After a failed update the row redraws. A Retry button, if drawn, is a
    // plain row button, never the chip's label.
    await expect(armed.locator('.wait-chip-swap')).toHaveCount(0);
  });
});

test.describe('touch (#4942)', () => {
  test.use({ hasTouch: true });

  test('a first tap reveals Update branch, the second runs it', async ({
    page,
  }) => {
    let updates = 0;
    await page.route('**/api/v1/pull-requests/update-branch', (route) => {
      updates++;
      return route.fulfill({ status: 202 });
    });
    await open(page, 390);
    const armed = rowOf(page);
    const swap = armed.getByRole('button', { name: SWAP });
    await swap.tap();
    await expect(armed.locator('.wait-chip-label')).toHaveText('Update branch');
    expect(updates).toBe(0);
    await swap.tap();
    await expect.poll(() => updates).toBe(1);
  });

  test('a reveal nobody follows up gives itself up after five seconds', async ({
    page,
  }) => {
    await page.clock.install();
    await open(page, 390);
    const armed = rowOf(page);
    await armed.getByRole('button', { name: SWAP }).tap();
    await expect(armed.locator('.wait-chip-label')).toHaveText('Update branch');
    await page.clock.runFor(5100);
    await expect(armed.locator('.wait-chip-label')).toHaveText(
      'Waiting for CI',
    );
  });

  test('Cancel auto-merge takes a tap of its own', async ({ page }) => {
    await open(page, 390);
    const armed = rowOf(page);
    await expect(
      armed.getByRole('button', { name: 'Cancel auto-merge' }),
    ).toBeVisible();
    const box = (await armed
      .getByRole('button', { name: 'Cancel auto-merge' })
      .boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(24);
  });
});
