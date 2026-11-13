import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { quickPill } from './quick-pills-helper';
import { test } from './server-fixture';

// #3734: the pull request pills are four single-choice groups (Forge, CI,
// Merge, Review) that combine with AND. Each has its own All, a chip removes
// one value, Clear filters resets every group, and on a phone the groups live
// in the Filters sheet with the active count on the button.

function pr(
  number: number,
  forge: 'github' | 'forgejo',
  ci: string,
  mergeStatus: string,
) {
  return {
    forge,
    repo: forge === 'github' ? 'alrayyes/app' : 'ryan/infra',
    number,
    title: `PR ${number}`,
    url: `https://example.com/${number}`,
    author: 'someone',
    draft: false,
    ci,
    mergeStatus,
    behind: false,
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Every combination below has at least one row, and every pill changes
// something, so each stays offered.
const PRS = [
  pr(1, 'github', 'failure', 'conflicting'),
  { ...pr(2, 'github', 'success', 'blocked'), readyToMerge: true },
  { ...pr(3, 'forgejo', 'failure', 'blocked'), needsReview: true },
  pr(4, 'forgejo', 'success', 'conflicting'),
];

async function open(
  page: Page,
  width = 1280,
  state?: object,
  prs: object[] = PRS,
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
        forges: [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: prs,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  if (state) {
    await page.route('**/api/v1/settings/filter-state', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(state),
          })
        : route.continue(),
    );
  }
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(
    state ? 2 : prs.length,
  );
}

const rows = (page: Page) => page.locator('#pr-rows > .row');

test.describe('pill groups combine (#3734)', () => {
  test('a Forge pick and a CI pick narrow together', async ({ page }) => {
    await open(page);
    await quickPill(page, 'Forgejo').click();
    await expect(rows(page)).toHaveCount(2);
    await quickPill(page, 'Failing').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText('PR 3');
    await expect(quickPill(page, 'Forgejo')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(quickPill(page, 'Failing')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('CI and Merge combine, and All clears only its own group', async ({
    page,
  }) => {
    await open(page);
    await quickPill(page, 'Failing').click();
    await quickPill(page, 'Conflicting').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText('PR 1');

    await quickPill(page, 'All', 'ci').click();
    await expect(rows(page)).toHaveCount(2);
    await expect(quickPill(page, 'Conflicting')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('on a phone a chip removes one value and Clear all resets every group', async ({
    page,
  }) => {
    await open(page, 390);
    await page.getByRole('button', { name: /^Filters/ }).click();
    const sheet = page.locator('dialog#filter-sheet');
    await sheet
      .locator('.sheet-pills[data-group="forge"]')
      .getByRole('button', { name: 'Forgejo' })
      .click();
    await sheet
      .locator('.sheet-pills[data-group="ci"]')
      .getByRole('button', { name: 'Failing' })
      .click();
    await expect(rows(page)).toHaveCount(1);
    await page.keyboard.press('Escape');

    const chips = page.locator('#active-filters');
    await chips.getByRole('button', { name: /Failing/ }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByRole('button', { name: /^Filters/ })).toHaveText(
      /Filters \(1\)/,
    );

    await page.getByRole('button', { name: /^Filters/ }).click();
    await sheet
      .locator('.sheet-pills[data-group="ci"]')
      .getByRole('button', { name: 'Failing' })
      .click();
    await sheet.getByRole('button', { name: 'Clear all' }).click();
    await expect(rows(page)).toHaveCount(PRS.length);
    for (const group of ['forge', 'ci'] as const)
      await expect(
        sheet
          .locator(`.sheet-pills[data-group="${group}"]`)
          .getByRole('button', { name: 'All' }),
      ).toHaveAttribute('aria-pressed', 'true');
  });

  test('a saved pr.quick moves to its group key once', async ({ page }) => {
    await open(page, 1280, { pr: { quick: 'failing' } });
    await expect(quickPill(page, 'Failing')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect
      .poll(async () => {
        const resp = await page.request.get('/api/v1/settings/filter-state');
        return (await resp.json())?.pr?.ci;
      })
      .toBeDefined();
  });

  for (const width of [360, 390, 1280]) {
    test(`at ${width}px each group is a labelled group and axe is clean`, async ({
      page,
    }) => {
      await open(page, width);
      if (width < 760) {
        await page.getByRole('button', { name: /^Filters/ }).click();
        const sheet = page.locator('dialog#filter-sheet');
        for (const name of ['Forge', 'CI', 'Merge', 'Review'])
          await expect(
            sheet.getByRole('group', { name, exact: true }),
          ).toBeVisible();
        await sheet
          .locator('.sheet-pills[data-group="ci"]')
          .getByRole('button', { name: 'Failing' })
          .click();
        await sheet
          .locator('.sheet-pills[data-group="forge"]')
          .getByRole('button', { name: 'GitHub' })
          .click();
        await expect(rows(page)).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: /^Filters/ })).toHaveText(
          /Filters \(2\)/,
        );
      } else {
        for (const name of ['Forge', 'CI', 'Merge', 'Review'])
          await expect(
            page.getByRole('group', { name, exact: true }),
          ).toBeVisible();
      }
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
