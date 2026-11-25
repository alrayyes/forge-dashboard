import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #4532: a wait that clears on its own is one line and no locked button. An
// Update branch that was asked for is the Updating branch chip alone; the
// "Behind the base branch" message and the greyed "Queued…" button leave the
// row. A block the person can act on keeps its locked button and reason.

const BEHIND = {
  code: 'behind',
  message: 'Behind the base branch',
};
const CI_BLOCK = {
  code: 'checks_pending',
  message: 'Waiting for CI to finish',
};

function pr(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number: 7,
    title: 'Behind',
    url: 'https://example.com/pull/7',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    status: { ...BEHIND, action: 'update_branch' },
    allowedActions: [
      { action: 'merge', blocked: BEHIND },
      { action: 'update_branch' },
      { action: 'close' },
    ],
    ...overrides,
  };
}

async function open(page: Page, pullRequest: unknown) {
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
        pullRequests: [pullRequest],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  return page.locator('#pr-rows > .row').first();
}

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

// The line is one line when its text box is no taller than one line-height.
async function lines(locator: Locator) {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    const lh =
      Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2;
    return Math.round(el.getBoundingClientRect().height / lh);
  });
}

const height = (row: Locator) =>
  row.evaluate((r) => Math.round(r.getBoundingClientRect().height));

const SCHEMES = [
  ['light', { colorScheme: 'light' }],
  ['dark', { colorScheme: 'dark' }],
  ['forced colours', { forcedColors: 'active' }],
] as const;

for (const width of [1280, 390]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    for (const [scheme, media] of SCHEMES) {
      test(`a requested update is the Updating branch chip alone (${scheme})`, async ({
        page,
      }, info) => {
        await page.emulateMedia(media);
        await page.route('**/api/v1/pull-requests/update-branch', (route) =>
          route.fulfill({ status: 202 }),
        );
        const row = await open(page, pr());
        const before = await height(row);
        await row.getByRole('button', { name: 'Update branch' }).click();

        await expect(row.locator('.wait-chip-label')).toHaveText(
          'Updating branch',
        );
        await expect(row.getByRole('button', { name: 'Queued…' })).toHaveCount(
          0,
        );
        await expect(row.locator('[aria-disabled="true"]')).toHaveCount(0);
        await expect(row).not.toContainText('Behind the base branch');
        await expect(row.locator('.wait-chip')).toBeVisible();
        // One line, and the row is no taller than it was with the button and
        // the message (measured: see the PR body).
        expect(await lines(row.locator('.wait-chip-label'))).toBe(1);
        const after = await height(row);
        info.annotations.push({
          type: 'row-height',
          description: `${scheme} ${width}px before ${before} after ${after}`,
        });
        expect(after).toBeLessThanOrEqual(before);
        await axeClean(page);
      });
    }

    for (const [scheme, media] of SCHEMES) {
      test(`an armed pull request waiting on CI has one line and no locked Merge (${scheme})`, async ({
        page,
      }) => {
        await page.emulateMedia(media);
        const row = await open(
          page,
          pr({
            ci: 'pending',
            behind: false,
            status: CI_BLOCK,
            autoMergeEnabled: true,
            autoMerge: {
              state: 'waiting',
              code: 'checks_pending',
              message: 'Auto-merge is waiting for checks to finish.',
            },
            allowedActions: [
              { action: 'merge', blocked: CI_BLOCK },
              { action: 'cancel_auto_merge' },
              { action: 'close' },
            ],
          }),
        );
        await expect(row.locator('.wait-chip-label')).toHaveText(
          'Waiting for CI',
        );
        await expect(
          row.getByRole('button', { name: 'Merge', exact: true }),
        ).toHaveCount(0);
        await expect(row.locator('[aria-disabled="true"]')).toHaveCount(0);
        expect(await lines(row.locator('.wait-chip-label'))).toBe(1);
        await axeClean(page);
      });
    }

    test('a block the person can act on keeps its locked button and reason', async ({
      page,
    }) => {
      const row = await open(
        page,
        pr({
          draft: true,
          behind: false,
          status: {
            code: 'draft',
            message: 'Draft pull request',
          },
          allowedActions: [
            {
              action: 'merge',
              blocked: {
                code: 'draft',
                message: 'Draft pull request',
              },
            },
            { action: 'close' },
          ],
        }),
      );
      await expect(row).toContainText('Draft pull request');
      await expect(
        row.getByRole('button', { name: 'Merge', exact: true }),
      ).toHaveAttribute('aria-disabled', 'true');
    });
  });
}

test('the pop-up keeps its Update branch button while the update is requested', async ({
  page,
}) => {
  await page.route('**/api/v1/pull-requests/update-branch', (route) =>
    route.fulfill({ status: 202 }),
  );
  const row = await open(page, pr());
  await row.getByRole('button', { name: 'Update branch' }).click();
  const dialog = await openActionsDialog(row);
  await expect(
    actionsFooter(dialog).getByRole('button', { name: /Update branch|Queued/ }),
  ).toBeVisible();
});
