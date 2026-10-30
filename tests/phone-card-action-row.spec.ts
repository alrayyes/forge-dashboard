import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// On a phone the one control a row draws sits in its own action row: after a
// hairline divider, full width and 44px tall, so the thumb finds it. The
// 44px is WCAG 2.5.5 (AAA); 2.5.8 (AA) asks 24px.
// https://github.com/alrayyes/forge-dashboard/issues/898

function pr(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number: 7,
    title: 'A longer pull request title that wraps onto a second line',
    url: 'https://example.com/pull/7',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
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
  await expect(row).toBeVisible();
  return row;
}

const cases = [
  { name: 'Merge', overrides: {} },
  {
    name: 'a locked Merge',
    overrides: { ci: 'failure', mergeStatus: 'blocked' },
  },
];

for (const width of [360, 390]) {
  for (const { name, overrides } of cases) {
    test(`${width}px: ${name} is one full-width 44px button after a divider`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const row = await open(page, pr(overrides));
      const bar = row.locator('.row-action-bar');
      await expect(bar).toBeVisible();
      expect(
        await bar.evaluate((el) => getComputedStyle(el).borderTopWidth),
      ).toBe('1px');

      const btn = bar.getByRole('button', { name: 'Merge' });
      const box = await btn.boundingBox();
      const barBox = await bar.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual((barBox?.width ?? 0) - 1);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
    });
  }
}

test('a locked Merge stays in the action row, greyed, with its reason', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const row = await open(page, pr({ ci: 'failure', mergeStatus: 'blocked' }));
  const bar = row.locator('.row-action-bar');
  const button = bar.getByRole('button', { name: 'Merge' });
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  // The status block above the bar says why, and the button is described by
  // it, so the reason is on screen and read out with the button.
  const describedBy = await button.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  const status = page.locator(`[id="${describedBy}"]`);
  await expect(status).toBeVisible();
  await expect(status).toContainText('CI is failing');
  const statusBox = await status.boundingBox();
  const barBox = await bar.boundingBox();
  expect((statusBox?.y ?? 0) + (statusBox?.height ?? 0)).toBeLessThanOrEqual(
    (barBox?.y ?? 0) + 1,
  );
});

test('a plain Merge is centred by the phone bar rule, full width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const row = await open(page, pr());
  const button = row.locator('.row-action-bar .row-action');
  const style = await button.evaluate((el) => {
    const s = getComputedStyle(el);
    return { justify: s.justifyContent, width: s.width, min: s.minHeight };
  });
  expect(style.justify).toBe('center');
  expect(style.min).toBe('44px');
  const barWidth = (await row.locator('.row-action-bar').boundingBox())?.width;
  expect(Number.parseFloat(style.width)).toBeCloseTo(barWidth ?? 0, 0);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe finds nothing on the phone card in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 900 });
    await open(page, pr());
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('on a desktop the button keeps its small size beside the status', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const row = await open(page, pr());
  const box = await row.getByRole('button', { name: 'Merge' }).boundingBox();
  const rowBox = await row.boundingBox();
  const pill = await row.locator('.ci-pill').boundingBox();
  expect(box?.height).toBeLessThan(44);
  expect(box?.width).toBeLessThan(200);
  // Right of the row's midline, inside the row, and no further left than the
  // CI pill beside it.
  expect(box?.x).toBeGreaterThan((rowBox?.x ?? 0) + (rowBox?.width ?? 0) / 2);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
    (rowBox?.x ?? 0) + (rowBox?.width ?? 0),
  );
  expect(box?.x).toBeGreaterThanOrEqual((pill?.x ?? 0) - 1);
  expect(
    await row
      .locator('.row-action-bar')
      .evaluate((el) => getComputedStyle(el).display),
  ).toBe('contents');
});
