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

  // The error pages are prerendered HTML that runs no script, so the Go
  // server fills the version into their footer when it starts. Every
  // unmatched address gets the 404 page, including /500.html asked for by
  // name and a bare /disclaimer, so the real binary is the only place this
  // can be checked. Dev binary in CI: the version slot is the dev label.
  for (const path of [
    '/nope',
    '/404.html',
    '/500.html',
    '/disclaimer',
    '/disclaimer/',
  ]) {
    test(`${path} (an error page) shows the same five footer items, none current`, async ({
      page,
    }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(page.locator('footer a')).toHaveText([
        'GitHub',
        'Disclaimer',
        'Privacy',
      ]);
      await expect(page.locator('footer')).toContainText(
        'Read-only mirror of both forges',
      );
      const text = await page
        .locator('footer')
        .evaluate((el) => (el as HTMLElement).innerText);
      expect(text).toMatch(
        /Read-only mirror.*GitHub\s+· (dev build|v\d\S*)\s+· Disclaimer\s+· Privacy/s,
      );
      await expect(page.locator('footer a[aria-current]')).toHaveCount(0);
    });
  }

  // CI builds a dev binary, so the unmocked version is the dev label.
  test('a dev build shows the same five items, with a dev build label', async ({
    page,
  }) => {
    await page.goto('/disclaimer.html');
    await expect(page.locator('#footer-version')).toContainText('dev build');
    await expect(page.locator('footer a')).toHaveText([
      'GitHub',
      'Disclaimer',
      'Privacy',
    ]);
    const text = await page
      .locator('footer')
      .evaluate((el) => (el as HTMLElement).innerText);
    expect(text).toMatch(
      /Read-only mirror.*GitHub\s+· dev build\s+· Disclaimer\s+· Privacy/s,
    );
    await expect(page.locator('footer a[aria-current]')).toHaveText(
      'Disclaimer',
    );
  });

  test.describe('signed in, nothing moves between pages', () => {
    test.use({ storageState: SHARED_STORAGE_STATE_PATH });

    for (const width of [360, 1280]) {
      test(`footer height and link positions match on every page at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await mockVersion(page);
        const layouts: { path: string; layout: unknown }[] = [];
        for (const path of [
          '/pull-requests.html',
          '/changelog.html',
          '/disclaimer.html',
          '/privacy.html',
        ]) {
          await page.goto(path);
          await expect(page.locator('footer a')).toHaveCount(4);
          const layout = await page.locator('footer').evaluate((el) => {
            const box = el.getBoundingClientRect();
            const origin = box.left;
            return {
              height: box.height,
              links: [...el.querySelectorAll('a')].map((a) => {
                const r = a.getBoundingClientRect();
                return [
                  Math.round(r.left - origin),
                  Math.round(r.top - box.top),
                  Math.round(r.width),
                  Math.round(r.height),
                ];
              }),
            };
          });
          layouts.push({ path, layout });
        }
        for (const { path, layout } of layouts) {
          expect(layout, path).toEqual(layouts[0].layout);
        }
      });
    }
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
        // Not colour alone: the current link is underlined 2px; the others 1px.
        const thickness = await page
          .locator('footer a')
          .evaluateAll((els) =>
            els.map((el) =>
              el.getAttribute('aria-current')
                ? getComputedStyle(el).textDecorationThickness
                : null,
            ),
          );
        expect(thickness.filter(Boolean)).toEqual(['2px']);
        const underlined = await page
          .locator('footer a[aria-current]')
          .evaluate((el) => getComputedStyle(el).textDecorationLine);
        expect(underlined).toContain('underline');
        await expectAxeAndNoSidewaysScroll(page);
      });
    }
  }
});
