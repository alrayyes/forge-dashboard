import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { viaActionsDialog } from './actions-dialog-helper';
import { test } from './server-fixture';

// The Pull requests header updates every listed pull request the server says
// can be brought up to date. Who counts and the wording are pinned in
// update-all.test.ts; these cases pin the wiring: the header, the confirm, the
// requests made and a refusal staying on its row.

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Change number ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    allowedActions: [{ action: 'update_branch' }],
    ...overrides,
  };
}

// Counts the refreshes the page asks for and, once `gate` is set, holds each
// one open until it resolves: a forge that is slow to answer a refresh.
type Reads = { count: number; gate: Promise<void> | null };

async function open(
  page: Page,
  pullRequests: ReturnType<typeof pr>[],
  reads: Reads = { count: 0, gate: null },
  forge: Record<string, unknown> = {},
) {
  const posts: Record<string, unknown>[] = [];
  const snapshot = () =>
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [{ forge: 'github', reachable: true, repoCount: 1, ...forge }],
      pullRequests,
      issues: [],
      repos: [],
      hiddenDrafts: 0,
    });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard/refresh*', async (route: Route) => {
    reads.count++;
    if (reads.gate) await reads.gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    });
  });
  await page.route('**/api/v1/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  await page.route('**/api/v1/dashboard?*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  await page.route('**/api/v1/pull-requests/update-branch', (route: Route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    if (body.number === 3) {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Conflicts',
          code: 'conflicts',
          message: 'The pull request has conflicts.',
        }),
      });
    }
    return route.fulfill({ status: 204 });
  });
  await page.goto('/pull-requests.html');
  return posts;
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('Update all updates the ticked rows', async ({ page }) => {
  const posts = await open(page, [
    pr(1),
    pr(2),
    pr(4),
    pr(5, { allowedActions: [] }),
  ]);
  const button = page.getByRole('button', { name: 'Update all (3)' });
  await expect(button).toBeVisible();
  await expect(page.getByText('can be updated.')).toHaveCount(0);
  await expect(noChip(page)).toHaveCount(0);

  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Update 3 pull requests?' });
  await expect(dialog.getByRole('checkbox')).toHaveCount(3);
  await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(3);
  await dialog.getByRole('checkbox').nth(2).uncheck();

  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => posts.map((p) => p.number)).toEqual([1, 2]);
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 2.',
  );
});

test('Update all does not wait on a board refresh between rows', async ({
  page,
}) => {
  const reads: Reads = { count: 0, gate: null };
  let release!: () => void;
  const posts = await open(page, [pr(1), pr(2), pr(4), pr(5)], reads);
  const header = page.getByRole('button', { name: 'Update all (4)' });
  await expect(header).toBeVisible();
  const readsBefore = reads.count;
  reads.gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await header.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Every request goes out and the run ends although no refresh has
  // answered, and the board asks for one refresh, not one per row.
  await expect.poll(() => posts.map((p) => p.number)).toEqual([1, 2, 4, 5]);
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 4.',
  );
  await expect.poll(() => reads.count - readsBefore).toBe(1);
  release();
});

test('a row Update branch still refreshes the board', async ({ page }) => {
  const reads: Reads = { count: 0, gate: null };
  await open(page, [pr(1)], reads);
  const row = page.locator('#pr-rows .row', { hasText: 'Change number 1' });
  await expect(row).toBeVisible();
  const readsBefore = reads.count;
  await viaActionsDialog(row, (footer) =>
    footer.getByRole('button', { name: 'Update branch' }).click(),
  );
  await expect.poll(() => reads.count - readsBefore).toBe(1);
});

test('the header counts the run while a request is open', async ({ page }) => {
  await open(page, [pr(1), pr(2)]);
  let answer!: () => void;
  const open2 = new Promise<void>((resolve) => {
    answer = resolve;
  });
  // Registered last, so it wins over the open() route for row 2.
  await page.route('**/api/v1/pull-requests/update-branch', async (route) => {
    if (route.request().postDataJSON().number === 2) await open2;
    await route.fulfill({ status: 204 });
  });

  const header = page.getByRole('button', { name: 'Update all (2)' });
  await header.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).toBeHidden();

  const running = page.getByRole('button', { name: /Updating 1 of 2/ });
  await expect(running).toBeVisible();
  // Focus went back to the header button when the dialog closed.
  await expect(running).toBeFocused();

  answer();
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 2.',
  );
});

test('a refused update shows its reason on its row', async ({ page }) => {
  const posts = await open(page, [pr(1), pr(3)]);
  await page.getByRole('button', { name: 'Update all (2)' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => posts.length).toBe(2);
  await expect(
    page.locator('#pr-rows .row', { hasText: 'Change number 3' }),
  ).toContainText('The pull request has conflicts.');
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 1 of 2. 1 failed.',
  );
});

test('Escape on the confirm updates nothing', async ({ page }) => {
  const posts = await open(page, [pr(1)]);
  await page.getByRole('button', { name: 'Update all (1)' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(posts).toEqual([]);
});

test('with nothing to update the button and its line are not shown', async ({
  page,
}) => {
  await open(page, [pr(1, { allowedActions: [] })]);
  await expect(page.locator('.board-head')).toBeVisible();
  await expect(page.locator('.update-all')).toBeHidden();
  await expect(page.getByRole('button', { name: /Update all/ })).toHaveCount(0);
});

test('Update all sits in the header controls, not in a strip under the header', async ({
  page,
}) => {
  await open(page, [pr(1)]);
  const button = page.getByRole('button', { name: 'Update all (1)' });
  await expect(button).toBeVisible();
  await expect(
    page.locator('.board-head-controls .update-all #update-all-button'),
  ).toHaveCount(1);
  await expect(page.locator('section.board > .update-all')).toHaveCount(0);
});

test(`the confirm fits a phone in light and dark and passes axe`, async ({
  page,
}) => {
  for (const scheme of ['light', 'dark'] as const) {
    await test.step(`${scheme}`, async () => {
      await page.emulateMedia({ colorScheme: scheme });

      await page.setViewportSize({ width: 360, height: 800 });

      await open(page, [pr(1), pr(2)]);

      await page.getByRole('button', { name: 'Update all (2)' }).click();

      await expect(page.getByRole('dialog')).toBeVisible();

      await expectNoAxeViolations(page);

      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
    });
  }
});

// The strip is the button alone (#3635). The count sits in its label, and the
// page header counts the listed rows ("12 open", or "Showing 4 of 12" under a
// filter), so no chip repeats either.
const noChip = (page: Page) => page.getByText(/ready to update/);

test('the strip is the button alone, with no ready chip', async ({ page }) => {
  await open(page, [pr(1), pr(2), pr(4), pr(5, { allowedActions: [] })]);
  await expect(
    page.getByRole('button', { name: 'Update all (3)' }),
  ).toBeVisible();
  await expect(noChip(page)).toHaveCount(0);
  await expect(page.locator('.update-all-chips')).toHaveCount(0);
  await expect(page.locator('.update-all-headline')).toHaveCount(0);
  await expect(page.getByText('can be updated.')).toHaveCount(0);
  await expect(page.locator('#pr-count')).toHaveText('4 open');
});

test('on a phone the button fills the block and is its only item', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, [pr(1), pr(2), pr(4), pr(5, { allowedActions: [] })]);
  await expect(noChip(page)).toHaveCount(0);
  const measure = () =>
    page.evaluate(() => {
      const r = (el: Element) => el.getBoundingClientRect();
      const block = document.querySelector('.update-all')!;
      const button = document.getElementById('update-all-button')!;
      const style = getComputedStyle(block);
      return {
        buttonLeft: r(button).left,
        buttonRight: r(button).right,
        buttonHeight: r(button).height,
        blockHeight: r(block).height,
        padY:
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom),
        items: block.children.length,
        left:
          r(block).left +
          Number.parseFloat(style.paddingLeft) +
          block.clientLeft,
        right:
          r(block).right -
          Number.parseFloat(style.paddingRight) -
          block.clientLeft,
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      };
    });
  await expect
    .poll(async () => {
      const m = await measure();
      return {
        leftAligned: Math.abs(m.buttonLeft - m.left) < 0.5,
        rightAligned: Math.abs(m.buttonRight - m.right) < 0.5,
        tallEnough: m.buttonHeight >= 44,
        // The strip is the button and its padding, one row.
        oneRow: Math.abs(m.blockHeight - m.padY - m.buttonHeight) < 0.5,
        items: m.items,
        fits: m.scrollW <= m.innerW,
      };
    })
    .toEqual({
      leftAligned: true,
      rightAligned: true,
      tallEnough: true,
      oneRow: true,
      items: 1,
      fits: true,
    });
});

test('the strip stays through a run and the button shows its progress', async ({
  page,
}) => {
  await open(page, [pr(1), pr(2)]);
  let answer!: () => void;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route('**/api/v1/pull-requests/update-branch', async (route) => {
    if (route.request().postDataJSON().number === 2) await held;
    await route.fulfill({ status: 204 });
  });
  await page.getByRole('button', { name: 'Update all (2)' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Update', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /Updating 1 of 2/ }),
  ).toBeVisible();
  await expect(page.locator('.update-all')).toBeVisible();
  await expect(noChip(page)).toHaveCount(0);
  answer();
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 2.',
  );
});

test('with nothing to update the strip is hidden', async ({ page }) => {
  await open(page, [pr(1, { allowedActions: [] })]);
  await expect(page.locator('.board-head')).toBeVisible();
  await expect(page.locator('.update-all')).toBeHidden();
});

test(`the strip passes axe in light and dark`, async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await test.step(`${scheme}`, async () => {
      await page.emulateMedia({ colorScheme: scheme });

      await open(page, [pr(1), pr(2, { allowedActions: [] })]);

      await expect(page.locator('.update-all')).toBeVisible();
      await expect(noChip(page)).toHaveCount(0);

      await expectNoAxeViolations(page);
    });
  }
});

test('the header counts the rows and the button only the ready ones', async ({
  page,
}) => {
  await open(page, [pr(1), pr(2), pr(3, { allowedActions: [] })]);
  await expect(page.locator('#pr-count')).toHaveText('3 open');
  await expect(
    page.getByRole('button', { name: 'Update all (2)' }),
  ).toBeVisible();
});

test('at 320px the button fits without sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await open(page, [pr(1), pr(2)]);
  const button = page.locator('#update-all-button');
  await expect(button).toBeVisible();
  await expect(noChip(page)).toHaveCount(0);
  const m = await page.evaluate(() => ({
    h: document.getElementById('update-all-button')!.getBoundingClientRect()
      .height,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  expect(m.h).toBeGreaterThanOrEqual(44);
  expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
});

// A read-only forge (budget spent) draws no Update branch on its rows, so
// Update all can't count them either (#3971).
test('a rate-limited forge draws no row button and no Update all count', async ({
  page,
}) => {
  const resetsAt = new Date(Date.now() + 600_000).toISOString();
  await open(
    page,
    [pr(1), pr(2)],
    { count: 0, gate: null },
    {
      rateLimitREST: { limit: 5000, remaining: 0, resetsAt },
    },
  );
  const row = page.locator('#pr-rows .row', { hasText: 'Change number 1' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Update branch' })).toHaveCount(
    0,
  );
  await expect(page.locator('#update-all-button')).not.toBeVisible();
});

test('a healthy forge counts the rows that draw Update branch', async ({
  page,
}) => {
  await open(page, [pr(1), pr(2)]);
  const rows = page.locator('#pr-rows .row');
  await expect(rows.getByRole('button', { name: 'Update branch' })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole('button', { name: 'Update all (2)' }),
  ).toBeVisible();
});
