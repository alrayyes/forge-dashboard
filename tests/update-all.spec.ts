import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
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

async function open(page: Page, pullRequests: ReturnType<typeof pr>[]) {
  const posts: Record<string, unknown>[] = [];
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
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
  await expect(dialog.locator('#update-all-progress')).toHaveText(
    'Update requested for 2.',
  );
  expect(posts.map((p) => p.number)).toEqual([1, 2]);
  await expect(page.locator('#update-all-status')).toHaveText(
    'Update requested for 2.',
  );
});

test('a refused update shows its reason on its row', async ({ page }) => {
  const posts = await open(page, [pr(1), pr(3)]);
  await page.getByRole('button', { name: 'Update all (2)' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog.locator('#update-all-progress')).toHaveText(
    'Update requested for 1 of 2. 1 failed.',
  );
  expect(posts).toHaveLength(2);
  await expect(
    dialog.getByRole('listitem').filter({ hasText: 'Change number 3' }),
  ).toContainText('The pull request has conflicts.');
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
