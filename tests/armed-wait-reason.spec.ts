import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { type Forge, forgeHealth } from './forge-health-helper';
import fixture from './generated/behind-status.json';
import { test } from './server-fixture';

// #4434: an armed pull request on a green pill says what the forge waits for
// when the row knows, and says so plainly when it doesn't. The wording is
// checked in web/src/lib/wait-chip.test.ts; this is the page.

type MockPR = Record<string, unknown>;

const message = 'Auto-merge is waiting for the forge to allow the merge.';

function armedGreen(overrides: MockPR = {}): MockPR {
  return {
    ...fixture.pullRequests.strict,
    ci: 'passed',
    behind: false,
    autoMerge: { state: 'waiting', code: 'not_mergeable', message },
    ...overrides,
  };
}

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
        forges: [forgeHealth(pr.forge as Forge)],
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

const chipOf = (page: Page) =>
  page.locator('#pr-rows > .row').first().locator('.wait-chip');

test.describe('an armed green pull request says what it waits for (#4434)', () => {
  test('a required review is named, and Disarm stays', async ({ page }) => {
    await open(
      page,
      armedGreen({
        review: {
          decision: 'review_required',
          approvals: 0,
          requestedReviewers: 0,
        },
      }),
    );
    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText(
      'Waiting for review',
    );
    await expect(chip.locator('.wait-chip-detail')).toHaveText(
      'A review is required',
    );
    await expect(chip.getByRole('button')).toBeVisible();
  });

  test('a check nothing has reported is named', async ({ page }) => {
    await open(page, armedGreen({ pendingChecks: ['lint'] }));
    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText(
      'Waiting for check',
    );
    await expect(chip.locator('.wait-chip-detail')).toHaveText('lint');
  });

  test('no reason is said plainly and Disarm is offered', async ({ page }) => {
    await open(page, armedGreen());
    const chip = chipOf(page);
    await expect(chip.locator('.wait-chip-label')).toHaveText(
      'Waiting for forge',
    );
    await expect(chip.locator('.wait-chip-detail')).toHaveText(
      'The forge gave no reason',
    );
    await expect(chip.getByRole('button')).toBeVisible();
  });

  test('the hint opens from the keyboard, and the chip has no axe violations in light and dark on a phone and a desktop', async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const [name, width, height] of [
        ['phone', 390, 844],
        ['desktop', 1280, 800],
      ] as const) {
        const where = `${name} in ${scheme}`;
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await open(
          page,
          armedGreen({
            review: {
              decision: 'review_required',
              approvals: 0,
              requestedReviewers: 0,
            },
          }),
        );
        const chip = chipOf(page);
        await chip.focus();
        await expect(chip.locator('.wait-chip-tip'), where).toBeVisible();
        await expect(chip.locator('.wait-chip-tip'), where).toContainText(
          'requires a review',
        );
        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(scrollWidth, where).toBeLessThanOrEqual(width);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, where).toEqual([]);
      }
    }
  });
});
