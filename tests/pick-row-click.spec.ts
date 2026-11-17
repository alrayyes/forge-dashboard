import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A click anywhere on a choice in a multi-select filter ticks its box, not
// only a click on the box itself (#4093). The row is one <label>, so the
// browser should do this on its own; the spec pins that it does, on the
// name, the padding and the picture, at desktop and phone width.

function pr(repo: string, n: number): Record<string, unknown> {
  return {
    forge: 'github',
    repo,
    number: n,
    title: `Change ${n}`,
    url: `https://example.com/${n}`,
    author: 'alice',
    draft: false,
    ci: 'success',
    mergeStatus: 'mergeable',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const snapshot = (prs: Record<string, unknown>[]) => ({
  generatedAt: new Date().toISOString(),
  forges: [{ forge: 'github', reachable: true, repoCount: prs.length }],
  pullRequests: prs,
  issues: [],
  repos: [],
  hiddenDrafts: 0,
});

const FEW = [pr('alrayyes/app', 1), pr('alrayyes/lib', 2)];
const MANY = Array.from({ length: 22 }, (_, i) =>
  pr(`alrayyes/r${String(i).padStart(2, '0')}`, i + 1),
);

async function open(page: Page, prs: Record<string, unknown>[]) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({ json: snapshot(prs) }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
  const filters = page.getByRole('button', { name: /^Filters/ });
  if (await filters.isVisible()) await filters.click();
  const button = page.locator('#shared-repo-filter-button:visible').first();
  await button.click();
  return button.locator('xpath=..');
}

const sizes = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
] as const;

for (const size of sizes) {
  test.describe(`a click on a pick row, ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('the name ticks the box, and again unticks it', async ({ page }) => {
      const host = await open(page, FEW);
      const box = host.getByRole('checkbox', { name: 'alrayyes/app' });
      await host.locator('.pick-name', { hasText: 'alrayyes/app' }).click();
      await expect(box).toBeChecked();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
      await host.locator('.pick-name', { hasText: 'alrayyes/app' }).click();
      await expect(box).not.toBeChecked();
      await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    });

    test('the row padding and the picture tick it too', async ({ page }) => {
      const host = await open(page, FEW);
      const row = host.locator('.label-filter-option', {
        hasText: 'alrayyes/lib',
      });
      const box = host.getByRole('checkbox', { name: 'alrayyes/lib' });
      const area = await row.boundingBox();
      if (!area) throw new Error('row not laid out');
      // The far right edge of the row is padding, past the name's text.
      await row.click({ position: { x: area.width - 4, y: area.height / 2 } });
      await expect(box).toBeChecked();
      await row.click({ position: { x: area.width - 4, y: area.height / 2 } });
      await expect(box).not.toBeChecked();
      const image = row.locator('.pick-image');
      if (await image.count()) {
        await image.click();
        await expect(box).toBeChecked();
      }
    });

    test('at the 20-pick cap a click on an unticked row changes nothing', async ({
      page,
    }) => {
      const host = await open(page, MANY);
      for (let i = 0; i < 20; i++)
        await host
          .locator('.pick-name', {
            hasText: `alrayyes/r${String(i).padStart(2, '0')}`,
          })
          .click();
      await expect(host.getByRole('checkbox', { checked: true })).toHaveCount(
        20,
      );
      const hint = host.locator('.label-filter-hint');
      await expect(hint).toContainText('Up to 20');
      const rows = await page.locator('#pr-rows > .row').count();
      await host
        .locator('.pick-name', { hasText: 'alrayyes/r21' })
        .click({ force: true });
      await expect(host.getByRole('checkbox', { checked: true })).toHaveCount(
        20,
      );
      await expect(page.locator('#pr-rows > .row')).toHaveCount(rows);
      await expect(hint).toContainText('Up to 20');
    });

    test('Tab then Space still toggles and keeps focus', async ({ page }) => {
      const host = await open(page, FEW);
      const box = host.getByRole('checkbox', { name: 'alrayyes/app' });
      await box.focus();
      await page.keyboard.press('Space');
      await expect(box).toBeChecked();
      await expect(box).toBeFocused();
    });

    for (const scheme of ['light', 'dark'] as const) {
      test(`${scheme}: no axe-core violations with the panel open`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        const host = await open(page, FEW);
        await host.locator('.pick-name', { hasText: 'alrayyes/app' }).click();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
}
