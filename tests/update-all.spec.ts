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
) {
  const posts: Record<string, unknown>[] = [];
  const snapshot = () =>
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
      pullRequests,
      issues: [],
      repos: [],
      hiddenDrafts: 0,
    });
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard/refresh*', async (route: Route) => {
    reads.count++;
    if (reads.gate) await reads.gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    });
  });
  await page.route('**/api/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  await page.route('**/api/dashboard?*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: snapshot(),
    }),
  );
  await page.route('**/api/pull-requests/update-branch', (route: Route) => {
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
  await expect(page.getByText('3 of 4 are out of date.')).toBeVisible();

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
  await page.route('**/api/pull-requests/update-branch', async (route) => {
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

test('Update all sits where Rebase all sits on the Bots page', async ({
  page,
}) => {
  await open(page, [pr(1)]);
  const head = await page.locator('.board-head').boundingBox();
  const block = await page.locator('.update-all').boundingBox();
  expect(head).not.toBeNull();
  expect(block).not.toBeNull();
  // Straight under the board header, as the Bots page's block is.
  expect(block!.y).toBeGreaterThanOrEqual(head!.y + head!.height);
  expect(block!.y - (head!.y + head!.height)).toBeLessThan(40);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the confirm fits a phone in ${scheme} and passes axe`, async ({
    page,
  }) => {
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
