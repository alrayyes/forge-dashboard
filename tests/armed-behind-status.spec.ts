import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { actionsFooter, openActionsDialog } from './actions-dialog-helper';
import fixture from './generated/behind-status.json';
import { test } from './server-fixture';

// #3428: an armed pull request that is behind says whether being behind is
// what holds it. Where the repo requires up-to-date branches the forge waits
// for someone to update the branch, so the chip says so and Update branch is
// offered. Where it doesn't, being behind is noise and the real hold (here a
// cancelled run) is named. The server sends the facts and the status code;
// the wording is checked in web/src/lib/wait-chip.test.ts and the rule in the
// Go tests.

type MockPR = Record<string, unknown>;

// The pull requests are the ones the server builds, from
// tests/generated/behind-status.json (#3601), so a field the server stops
// sending fails here instead of passing against a hand-written payload.
function armedBehind(overrides: MockPR = {}): MockPR {
  return { ...fixture.pullRequests.strict, ...overrides };
}

const strictMessage = fixture.pullRequests.strict.autoMerge.message;
const cancelledMessage = fixture.pullRequests.notStrict.autoMerge.message;

async function open(page: Page, pr: MockPR) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: pr.forge as string, reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
}

const row = (page: Page) => page.locator('#pr-rows > .row').first();

test.describe('an armed pull request that is behind (#3428)', () => {
  test('in a repo that requires up-to-date branches it waits for the branch to be updated, and Update branch is offered', async ({
    page,
  }) => {
    await open(page, armedBehind());
    const chip = row(page).locator('.wait-chip');

    await expect(chip.locator('.wait-chip-label')).toHaveText(
      'Waiting for update',
    );
    await expect(chip.locator('.wait-chip-detail')).toHaveText(
      'The branch must be up to date',
    );
    await expect(chip.locator('.wait-chip-tip')).toHaveText(strictMessage);
    await expect(row(page)).not.toContainText('Waiting for CI');
    await expect(row(page).locator('.auto-merge-status')).toHaveCount(0);

    const dialog = await openActionsDialog(row(page));
    await expect(
      actionsFooter(dialog).getByRole('button', { name: 'Update branch' }),
    ).toBeVisible();
  });

  test('where the repo does not require it, being behind is not blamed and the cancelled run is named', async ({
    page,
  }) => {
    await open(page, armedBehind(fixture.pullRequests.notStrict));
    const chip = row(page).locator('.wait-chip');

    await expect(chip.locator('.wait-chip-label')).toHaveText('Waiting for CI');
    await expect(chip.locator('.wait-chip-tip')).toHaveText(cancelledMessage);
    await expect(row(page)).not.toContainText('Waiting for update');
    await expect(row(page)).not.toContainText('up to date');
  });

  test('a refused update (conflict) stays stopped and the armed state stays visible', async ({
    page,
  }) => {
    await open(
      page,
      armedBehind({
        mergeStatus: 'conflicting',
        autoMerge: {
          state: 'stopped',
          code: 'conflict',
          message:
            'Auto-merge stopped: merge conflict. Resolve it on GitHub and it carries on.',
        },
        allowedActions: [
          {
            action: 'update_branch',
            blocked: {
              code: 'conflict',
              message: 'Conflicts need fixing by hand.',
            },
          },
          { action: 'cancel_auto_merge' },
          { action: 'close' },
        ],
      }),
    );

    await expect(row(page).locator('.auto-merge-status')).toContainText(
      'Stopped: Auto-merge stopped: merge conflict.',
    );
    await expect(row(page)).toContainText('Auto-merge');
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, width, height] of [
      ['phone', 390, 844],
      ['tablet', 820, 1180],
      ['desktop', 1280, 800],
    ] as const) {
      test(`the waiting chip fits and has no axe violations on a ${name} in ${scheme}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await open(page, armedBehind());

        const chip = row(page).locator('.wait-chip');
        await expect(chip).toBeVisible();
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth).toBeLessThanOrEqual(width);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
