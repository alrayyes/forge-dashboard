import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Pull requests header merges every listed pull request the server says
// can merge now. Who counts and the wording are pinned in merge-all.test.ts;
// these cases pin the wiring: the header, the confirm, the requests made and
// a refusal staying on its row.

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
    behind: false,
    allowedActions: [{ action: 'merge', primary: true }],
    ...overrides,
  };
}

async function open(page: Page, pullRequests: ReturnType<typeof pr>[]) {
  const posts: Record<string, unknown>[] = [];
  const merged = new Set<number>();
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: pullRequests.filter((p) => !merged.has(p.number)),
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.route('**/api/pull-requests/merge', (route: Route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    if (body.number === 3) {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Not mergeable',
          code: 'not_mergeable',
          message: 'The pull request has conflicts.',
        }),
      });
    }
    merged.add(body.number);
    const branchDeletion =
      body.number === 2
        ? { outcome: 'skipped', reason: 'protected' }
        : { outcome: 'deleted' };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ branchDeletion }),
    });
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

test('Merge all merges the ticked rows and deletes their branches', async ({
  page,
}) => {
  const posts = await open(page, [
    pr(1),
    pr(2),
    pr(4),
    pr(5, { allowedActions: [] }),
  ]);
  const button = page.getByRole('button', { name: 'Merge all (3)' });
  await expect(button).toBeVisible();
  await expect(page.getByText('3 of 4 are ready to merge.')).toBeVisible();

  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Merge 3 pull requests?' });
  await expect(dialog.getByRole('checkbox')).toHaveCount(3);
  await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(3);
  await expect(dialog).toContainText('Source branches are deleted');
  await dialog.getByRole('checkbox').nth(2).uncheck();

  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(dialog.locator('#merge-all-progress')).toHaveText('Merged 2.');
  expect(posts.map((p) => [p.number, p.deleteBranch])).toEqual([
    [1, true],
    [2, true],
  ]);
  await expect(page.locator('#merge-all-status')).toHaveText('Merged 2.');
});

test('a refused merge shows its reason on its row', async ({ page }) => {
  const posts = await open(page, [pr(1), pr(3)]);
  await page.getByRole('button', { name: 'Merge all (2)' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(dialog.locator('#merge-all-progress')).toHaveText(
    'Merged 1 of 2. 1 failed.',
  );
  expect(posts).toHaveLength(2);
  await expect(
    dialog.getByRole('listitem').filter({ hasText: 'Change number 3' }),
  ).toContainText('The pull request has conflicts.');
});

test('Escape on the confirm merges nothing', async ({ page }) => {
  const posts = await open(page, [pr(1)]);
  await page.getByRole('button', { name: 'Merge all (1)' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(posts).toEqual([]);
});

test('with nothing ready the button is disabled and says so', async ({
  page,
}) => {
  await open(page, [pr(1, { allowedActions: [] })]);
  await expect(page.getByRole('button', { name: 'Merge all' })).toBeDisabled();
  await expect(page.getByText('Nothing is ready to merge.')).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the confirm fits a phone in ${scheme} and passes axe`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 360, height: 800 });
    await open(page, [pr(1), pr(2)]);
    await page.getByRole('button', { name: 'Merge all (2)' }).click();
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
