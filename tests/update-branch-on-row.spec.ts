import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A behind pull request the forge still calls mergeable keeps Merge as its
// row button, and the Update branch the server lists used to sit only in the
// pop-up: the row showed an Out of date chip, a gap, then Merge. The row now
// draws Update branch beside the primary action, once, and never a second copy
// when the Behind warning already holds it.
// https://github.com/alrayyes/forge-dashboard/issues/3691

function pr(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number: 7,
    title: 'Add the thing',
    url: 'https://example.com/pull/7',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: true,
    ...overrides,
  };
}

async function open(page: Page, width: number, pullRequest: unknown) {
  await page.setViewportSize({ width, height: 844 });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pullRequest],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  const row = page.locator('#pr-rows > .row').first();
  await row.waitFor();
  return row;
}

for (const width of [360, 390, 1280]) {
  test(`a mergeable behind pull request offers Update branch beside Merge at ${width}px (#3691)`, async ({
    page,
  }) => {
    const row = await open(page, width, pr());
    const update = row.getByRole('button', { name: 'Update branch' });
    await expect(update).toHaveCount(1);
    await update.scrollIntoViewIfNeeded();
    await expect(update).toBeVisible();
    await expect(row.getByRole('button', { name: 'Merge' })).toBeVisible();
    if (width < 780) {
      const box = await update.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await update.focus();
    await expect(update).toBeFocused();

    if (width !== 360) {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    }
  });
}

test('a behind pull request whose warning holds Update branch has no second copy on the row', async ({
  page,
}) => {
  const row = await open(page, 390, pr({ mergeStatus: 'blocked' }));
  await expect(row.getByRole('button', { name: 'Update branch' })).toHaveCount(
    1,
  );
  await expect(
    row.locator('.status-area').getByRole('button', { name: 'Update branch' }),
  ).toHaveCount(1);
});

test('a behind pull request with a known conflict shows Update branch locked with its reason', async ({
  page,
}) => {
  const row = await open(page, 390, pr({ mergeStatus: 'conflicting' }));
  await expect(row.getByRole('button', { name: /Update branch/ })).toHaveCount(
    1,
  );
});

test('a pull request that is not behind has no Update branch on the row', async ({
  page,
}) => {
  const row = await open(page, 390, pr({ behind: false }));
  await expect(row.getByRole('button', { name: /Update branch/ })).toHaveCount(
    0,
  );
});
