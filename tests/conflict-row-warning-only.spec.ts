import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A confirmed conflict draws its warning and nothing it contradicts: no locked
// Merge, no locked Update branch, no Out of date chip. An unconfirmed Forgejo
// conflict keeps a live Update branch, a behind row with a live Update branch
// drops the chip, and the pop-up footer still lists every action with its
// reason. The Out of date quick filter keeps reading `behind`.
// https://github.com/alrayyes/forge-dashboard/issues/3770

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'forgejo',
    repo: 'example/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'someone',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    kind: 'regular',
    ...overrides,
  };
}

async function open(page: Page, width: number, prs: unknown[]) {
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
        forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
        pullRequests: prs,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

const PRS = [
  pr(1, {
    title: 'Refused with conflict',
    mergeStatus: 'conflicting',
    conflictConfirmed: true,
  }),
  pr(2, {
    title: 'Flag only conflict',
    mergeStatus: 'conflicting',
    conflictConfirmed: false,
    // The stand-in has no unconfirmed axis, so the mock says what the server
    // does: Update branch stays live, since updating is how it finds out.
    allowedActions: [
      {
        action: 'merge',
        blocked: {
          code: 'conflict',
          message: 'Merge conflict.',
          next: 'Resolve it on the forge to unlock Merge',
        },
      },
      { action: 'update_branch' },
      { action: 'close' },
    ],
  }),
  pr(3, { title: 'Plain behind' }),
  pr(4, { title: 'Up to date', behind: false }),
];

for (const width of [360, 390, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, width, PRS);
    });

    test('AC1: a confirmed conflict shows the warning and no Merge, Update branch or Out of date', async ({
      page,
    }) => {
      const r = row(page, 'Refused with conflict');
      await expect(r.locator('.merge-pill')).toHaveText('Conflicting');
      await expect(r.locator('.status-area')).toContainText('Merge conflict');
      await expect(
        r.getByRole('button', { name: 'Merge', exact: true }),
      ).toHaveCount(0);
      await expect(
        r.getByRole('button', { name: 'Update branch' }),
      ).toHaveCount(0);
      await expect(r.locator('.attr-chip.behind')).toHaveCount(0);
      expect((await axe(page)).violations).toEqual([]);
    });

    test('AC2: a behind row with a live Update branch has no Out of date chip', async ({
      page,
    }) => {
      const r = row(page, 'Plain behind');
      const update = r.getByRole('button', { name: 'Update branch' });
      await expect(update).toHaveCount(1);
      await expect(update).not.toHaveAttribute('aria-disabled', 'true');
      await expect(r.locator('.attr-chip.behind')).toHaveCount(0);
      expect((await axe(page)).violations).toEqual([]);
    });

    test('AC3: an unconfirmed conflict shows its pill and a live Update branch', async ({
      page,
    }) => {
      const r = row(page, 'Flag only conflict');
      await expect(
        r.getByRole('button', { name: 'Conflict not confirmed' }),
      ).toBeVisible();
      const update = r.getByRole('button', { name: 'Update branch' });
      await expect(update).toHaveCount(1);
      await expect(update).not.toHaveAttribute('aria-disabled', 'true');
      await expect(r.locator('.attr-chip.behind')).toHaveCount(0);
    });
  });
}

test('AC4: a conflicting pull request pop-up footer still lists Merge and Update branch locked with reasons', async ({
  page,
}) => {
  await open(page, 1280, PRS);
  await row(page, 'Refused with conflict')
    .getByRole('button', { name: /^#1 / })
    .click();
  const dialog = page.locator('dialog[open]');
  const merge = dialog.getByRole('button', { name: 'Merge', exact: true });
  const update = dialog.getByRole('button', { name: 'Update branch' });
  await expect(merge).toHaveAttribute('aria-disabled', 'true');
  await expect(update).toHaveAttribute('aria-disabled', 'true');
  await expect(dialog).toContainText('Conflicts need fixing by hand');
  expect((await axe(page)).violations).toEqual([]);
});

test('AC5: the Out of date quick filter still keeps every behind pull request', async ({
  page,
}) => {
  await open(page, 1280, PRS);
  await page.getByRole('button', { name: /^Out of date/ }).click();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(3);
  await expect(row(page, 'Up to date')).toHaveCount(0);
});
