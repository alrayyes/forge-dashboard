import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

// The run link sits in a footer under a divider, outside the scrolling body, so
// a long list never pushes it off screen (#3876).

const LINK_NAME = 'Open run on GitHub (opens in a new tab)';

function snapshot() {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: [
      {
        forge: 'github',
        repo: 'example/app',
        number: 42,
        title: 'Add structured logging',
        url: 'https://example.com/42',
        author: 'claude',
        draft: false,
        ci: 'success',
        checks: { passed: 4, running: 0, waiting: 0, failed: 0 },
        labels: [],
        createdAt: new Date(Date.now() - 3600_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        mergeStatus: 'blocked',
        status: 'blocked',
        kind: 'regular',
        behind: false,
        allowedActions: [],
      },
    ],
    issues: [],
  };
}

function jobs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `job-${i + 1}`,
    status: 'completed',
    conclusion: 'success',
    url: `https://github.com/example/app/actions/runs/9/job/${i + 1}`,
  }));
}

async function open(
  page: Page,
  size: { width: number; height: number },
  count: number,
  scheme: 'light' | 'dark' = 'light',
) {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: scheme });
  await serveChecks(page, () => jobs(count));
  await page.route('**/api/v1/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot()),
    }),
  );
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  await expect(page.locator('#pipeline-dialog .pipeline-check')).toHaveCount(
    count,
  );
}

const dialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Pipeline checks' });
const link = (page: Page) =>
  dialog(page).getByRole('link', { name: LINK_NAME });

async function insideViewport(page: Page) {
  const box = await link(page).boundingBox();
  const view = page.viewportSize();
  expect(box).not.toBeNull();
  if (!box || !view) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
}

const SIZES = [
  { width: 360, height: 640 },
  { width: 390, height: 780 },
  { width: 1280, height: 800 },
  { width: 844, height: 390 },
];

test.describe('pipeline dialog footer', () => {
  for (const size of SIZES) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const count of [4, 40]) {
        test(`the run link is on screen at ${size.width}x${size.height}, ${scheme}, ${count} checks`, async ({
          page,
        }) => {
          await open(page, size, count, scheme);
          await expect(link(page)).toBeVisible();
          await insideViewport(page);
        });
      }
    }
  }

  test('the run link stays on screen at 200% root font', async ({ page }) => {
    await page.addInitScript(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await open(page, { width: 390, height: 780 }, 40);
    await insideViewport(page);
  });

  test('it is a real outlined button, full width and 44px high on a phone', async ({
    page,
  }) => {
    await open(page, { width: 390, height: 780 }, 40);
    const footer = dialog(page).locator('.pipeline-dialog-footer');
    await expect(footer.getByRole('link', { name: LINK_NAME })).toHaveCount(1);
    await expect(
      dialog(page)
        .locator('.pipeline-dialog-body')
        .getByRole('link', { name: LINK_NAME }),
    ).toHaveCount(0);
    const m = await link(page).evaluate((el) => {
      const a = el.getBoundingClientRect();
      const f = el.parentElement?.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        height: a.height,
        width: a.width,
        footerWidth: f?.width ?? 0,
        border: Number.parseFloat(s.borderTopWidth),
        background: s.backgroundColor,
      };
    });
    expect(m.height).toBeGreaterThanOrEqual(44);
    expect(m.border).toBeGreaterThan(0);
    expect(m.width).toBeGreaterThan(m.footerWidth - 40);
    await expect(link(page)).toHaveText('Open run on GitHub');
    await expect(link(page).locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await expect(link(page)).toHaveAttribute('target', '_blank');
    await expect(link(page)).toHaveAttribute('rel', /noopener/);
  });

  test('on desktop it is at least 24px high and left aligned', async ({
    page,
  }) => {
    await open(page, { width: 1280, height: 800 }, 4);
    const box = await link(page).boundingBox();
    const sheet = await dialog(page).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
    expect((box?.x ?? 0) - (sheet?.x ?? 0)).toBeLessThan(40);
  });

  test('the body scrolls to its last row above the footer', async ({
    page,
  }) => {
    await open(page, { width: 390, height: 780 }, 40);
    const last = dialog(page).locator('.pipeline-check').last();
    await last.scrollIntoViewIfNeeded();
    const lastBox = await last.boundingBox();
    const linkBox = await link(page).boundingBox();
    expect((lastBox?.y ?? 0) + (lastBox?.height ?? 0)).toBeLessThanOrEqual(
      linkBox?.y ?? 0,
    );
  });

  test('it is the last stop in tab order', async ({ page }) => {
    await open(page, { width: 390, height: 780 }, 4);
    await dialog(page).getByRole('link', { name: /job-4/ }).first().focus();
    await page.keyboard.press('Tab');
    await expect(link(page)).toBeFocused();
    await expect(link(page)).toHaveCSS('outline-style', 'solid');
  });

  for (const mode of ['light', 'dark', 'forced'] as const) {
    test(`axe finds nothing in ${mode}`, async ({ page }) => {
      if (mode === 'forced')
        await page.emulateMedia({ forcedColors: 'active' });
      await open(
        page,
        { width: 390, height: 780 },
        40,
        mode === 'dark' ? 'dark' : 'light',
      );
      if (mode === 'forced')
        await page.emulateMedia({ forcedColors: 'active' });
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
