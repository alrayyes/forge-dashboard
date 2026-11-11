import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Rebase all says which out-of-date rows it leaves out and why (#3281), in
// the header strip and in the confirm dialog's second group.

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Bump dependency ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'dependabot[bot]',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    allowedActions: [{ action: 'dependabot_rebase', primary: true }],
    ...overrides,
  };
}

async function open(page: Page, pullRequests: unknown[]) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route(/\/api\/v1\/dashboard(\/refresh)?(\?.*)?$/, (route: Route) =>
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
  await page.route('**/api/v1/pull-requests/dependabot-action', (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.goto('/bots.html');
}

async function askOnce(page: Page, title: string) {
  await page
    .locator('#pr-rows > .row', { hasText: title })
    .getByRole('button', { name: /Dependabot: Rebase/ })
    .click();
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const blockedRow = (number: number) =>
  pr(number, {
    allowedActions: [
      {
        action: 'dependabot_rebase',
        blocked: { code: 'conflict', message: 'Conflicts need a human.' },
      },
    ],
  });

test('the header names how many are left out and why', async ({ page }) => {
  await open(page, [pr(1), pr(2), pr(3)]);
  await askOnce(page, 'Bump dependency 2');
  await expect(
    page.getByRole('button', { name: 'Rebase all (2)' }),
  ).toBeVisible();
  await expect(page.locator('.rebase-all-headline')).toHaveText(
    '3 of 3 are out of date.',
  );
  await expect(page.locator('.rebase-all-reason')).toHaveText(
    '2 can be rebased. 1 is left out: Rebase requested.',
  );
});

test('the dialog lists the rows that rebase, then the ones left out', async ({
  page,
}) => {
  await open(page, [pr(1), pr(2), blockedRow(3)]);
  await askOnce(page, 'Bump dependency 2');
  await page.getByRole('button', { name: 'Rebase all (1)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rebase 1 pull request?' });
  await expect(dialog).toBeVisible();
  const will = dialog.locator('#rebase-all-list > li');
  await expect(will).toHaveCount(1);
  await expect(will).toContainText('#1');
  const left = dialog.locator('#rebase-all-left-out-list > li');
  await expect(left).toHaveCount(2);
  await expect(left.nth(0)).toContainText('#2');
  await expect(left.nth(0)).toContainText('Rebase requested.');
  await expect(left.nth(1)).toContainText('#3');
  await expect(left.nth(1)).toContainText('Conflicts need a human.');
  await expect(
    dialog.getByRole('heading', { name: 'Left out (2)' }),
  ).toBeVisible();
});

test('with every behind row rebasable there is no second group', async ({
  page,
}) => {
  await open(page, [pr(1), pr(2)]);
  await expect(page.locator('.rebase-all-reason')).toBeHidden();
  await page.getByRole('button', { name: 'Rebase all (2)' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#rebase-all-left-out')).toBeHidden();
  await expect(page.locator('#rebase-all-left-out-list > li')).toHaveCount(0);
});

for (const [scheme, width] of [
  ['light', 320],
  ['light', 390],
  ['dark', 390],
  ['light', 1280],
  ['dark', 1280],
] as const) {
  test(`the left-out header and dialog fit at ${width}px in ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 800 });
    await open(page, [pr(1), pr(2), blockedRow(3)]);
    await askOnce(page, 'Bump dependency 2');
    const button = page.getByRole('button', { name: 'Rebase all (1)' });
    await button.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#rebase-all-cancel')).toBeFocused();
    await expectNoAxeViolations(page);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    if (width < 640) {
      for (const id of ['rebase-all-cancel', 'rebase-all-confirm']) {
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  });
}
