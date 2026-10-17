import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// #1679 (WCAG 2.2 3.2.3 Consistent Navigation): every page with a footer
// shows the same items in the same order. The page you're on keeps its link
// and marks it aria-current="page". The owner decided this; it replaces
// hiding the link on its own page.
// https://github.com/alrayyes/forge-dashboard/issues/1679

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const EXPECTED = ['GitHub', 'v1.2.3', 'Disclaimer', 'Privacy'] as const;

// Which footer link is current at each path; absent means none.
const SIGNED_IN: Record<string, string | undefined> = {
  '/': undefined,
  '/pull-requests.html': undefined,
  '/issues.html': undefined,
  '/releases.html': undefined,
  '/insights.html': undefined,
  '/bots.html': undefined,
  '/settings.html': undefined,
  '/webhooks.html': undefined,
  '/changelog.html': 'v1.2.3',
  '/disclaimer.html': 'Disclaimer',
  '/privacy.html': 'Privacy',
};
const SIGNED_OUT: Record<string, string | undefined> = {
  '/login.html': undefined,
  '/disclaimer.html': 'Disclaimer',
  '/privacy.html': 'Privacy',
};

async function mockVersion(page: Page) {
  await page.route('**/api/version', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: '1.2.3' }),
    }),
  );
}

async function expectFooter(page: Page, current: string | undefined) {
  const links = page.locator('footer a');
  await expect(links).toHaveText([...EXPECTED]);
  await expect(page.locator('footer')).toContainText(
    'Read-only mirror of both forges',
  );
  const marked = page.locator('footer a[aria-current]');
  if (current) {
    await expect(marked).toHaveCount(1);
    await expect(marked).toHaveText(current);
    await expect(marked).toHaveAttribute('aria-current', 'page');
  } else {
    await expect(marked).toHaveCount(0);
  }
}

async function expectAxeAndNoSidewaysScroll(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(results.violations).toEqual([]);
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('the footer is the same on every page', () => {
  test.describe('signed in', () => {
    test.use({ storageState: SHARED_STORAGE_STATE_PATH });

    for (const [path, current] of Object.entries(SIGNED_IN)) {
      test(`${path} shows the same footer items`, async ({ page }) => {
        await mockVersion(page);
        await page.goto(path);
        await expectFooter(page, current);
      });
    }
  });

  test.describe('signed out', () => {
    for (const [path, current] of Object.entries(SIGNED_OUT)) {
      test(`${path} shows the same footer items`, async ({ page }) => {
        await mockVersion(page);
        await page.goto(path);
        await expectFooter(page, current);
      });
    }
  });

  test('the 404 page shows the same footer items except the version, none current', async ({
    page,
  }) => {
    await mockVersion(page);
    const response = await page.goto('/some/missing/address');
    expect(response?.status()).toBe(404);
    // The 404 and 500 pages are finished HTML with no client script
    // (csr = false, #1175), so the footer's version fetch never runs and the
    // version is the one item they can't show. Everything else matches.
    await expect(page.locator('footer a')).toHaveText([
      'GitHub',
      'Disclaimer',
      'Privacy',
    ]);
    await expect(page.locator('footer a[aria-current]')).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const path of ['/disclaimer.html', '/privacy.html']) {
      test(`${path} at 360px in ${scheme}: current link, no sideways scroll, axe clean`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width: 360, height: 800 });
        await mockVersion(page);
        await page.goto(path);
        await expectFooter(
          page,
          path === '/disclaimer.html' ? 'Disclaimer' : 'Privacy',
        );
        // Not colour alone: the current link is bolder than its siblings.
        const weights = await page
          .locator('footer a')
          .evaluateAll((els) =>
            els.map((el) => Number(getComputedStyle(el).fontWeight)),
          );
        const marked = await page
          .locator('footer a[aria-current]')
          .evaluate((el) => Number(getComputedStyle(el).fontWeight));
        expect(marked).toBeGreaterThan(Math.min(...weights));
        await expectAxeAndNoSidewaysScroll(page);
      });
    }
  }
});
