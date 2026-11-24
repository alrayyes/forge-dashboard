import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// #1679 (WCAG 2.2 3.2.3 Consistent Navigation): every page with a footer
// shows the same items in the same order. The page you're on keeps its link
// and marks it aria-current="page". The owner decided this; it replaces
// hiding the link on its own page.
// https://github.com/alrayyes/forge-dashboard/issues/1679

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const EXPECTED = ['GitHub', 'v1.2.3', 'Disclaimer', 'Privacy'] as const;
// A signed-out visitor is never told the version (#4427), so the footer has
// no version link to show.
const EXPECTED_SIGNED_OUT = ['GitHub', 'Disclaimer', 'Privacy'] as const;

// Which footer link is current at each path; absent means none.
const SIGNED_IN: Record<string, string | undefined> = {
  '/': undefined,
  '/pull-requests.html': undefined,
  '/issues.html': undefined,
  '/releases.html': undefined,
  '/insights.html': undefined,
  '/bots.html': undefined,
  '/settings.html': undefined,
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

async function expectFooter(
  page: Page,
  current: string | undefined,
  expected: readonly string[] = EXPECTED,
) {
  const links = page.locator('footer a');
  await expect.soft(links).toHaveText([...expected]);
  await expect
    .soft(page.locator('footer'))
    .not.toContainText('Read-only mirror');
  const marked = page.locator('footer a[aria-current]');
  if (current) {
    await expect.soft(marked).toHaveCount(1);
    await expect.soft(marked).toHaveText(current);
    await expect.soft(marked).toHaveAttribute('aria-current', 'page');
  } else {
    await expect.soft(marked).toHaveCount(0);
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
    test('every page shows the same footer items', async ({ page }) => {
      await mockVersion(page);
      for (const [path, current] of Object.entries(SIGNED_IN)) {
        await test.step(path, async () => {
          await page.goto(path);
          await expectFooter(page, current);
        });
      }
    });
  });

  test.describe('signed out', () => {
    test.beforeEach(async ({ context }) => {
      await context.clearCookies();
    });

    // The real server answers /api/version with a 401 here, so nothing is
    // mocked: the footer has to cope with the refusal, not a canned version.
    test('every page shows the footer without a version', async ({ page }) => {
      for (const [path, current] of Object.entries(SIGNED_OUT)) {
        await test.step(path, async () => {
          await page.goto(path);
          await expectFooter(page, current, EXPECTED_SIGNED_OUT);
          await expect(page.locator('#footer-version')).toBeEmpty();
        });
      }
    });

    test('the public pages have no axe violations in light and dark', async ({
      page,
    }) => {
      for (const scheme of ['light', 'dark'] as const) {
        for (const path of Object.keys(SIGNED_OUT)) {
          await test.step(`${path} ${scheme}`, async () => {
            await page.emulateMedia({ colorScheme: scheme });
            await page.goto(path);
            await expectFooter(page, SIGNED_OUT[path], EXPECTED_SIGNED_OUT);
            const results = await new AxeBuilder({ page })
              .withTags(AXE_TAGS)
              .analyze();
            expect(results.violations).toEqual([]);
          });
        }
      }
    });
  });

  // The error pages are prerendered HTML that runs no script, and anyone can
  // trigger one, so they carry no version (#4427). Every unmatched address
  // gets the 404 page, including /500.html asked for by name and a bare
  // /disclaimer, so the real binary is the only place this can be checked.
  test('the error pages show the same footer items without a version, none current', async ({
    page,
  }) => {
    for (const path of [
      '/nope',
      '/404.html',
      '/500.html',
      '/disclaimer',
      '/disclaimer/',
    ]) {
      await test.step(path, async () => {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(404);
        await expect(page.locator('footer')).not.toContainText(
          'Read-only mirror',
        );
        await expect(page.locator('#footer-version')).toBeEmpty();
        await expect(page.locator('footer a')).toHaveText([
          'GitHub',
          'Disclaimer',
          'Privacy',
        ]);
        const text = await page
          .locator('footer')
          .evaluate((el) =>
            (el as HTMLElement).innerText.replace(/\u00a0/g, ' ').trim(),
          );
        expect(text).toMatch(/^GitHub\s+· Disclaimer\s+· Privacy$/);
        await expect(page.locator('footer a[aria-current]')).toHaveCount(0);
      });
    }
  });

  test.describe('signed in, nothing moves between pages', () => {
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

  test('/disclaimer.html and /privacy.html at 360px in both themes: current link, no sideways scroll, axe clean', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await mockVersion(page);
    for (const scheme of ['light', 'dark'] as const) {
      for (const path of ['/disclaimer.html', '/privacy.html']) {
        await test.step(`${path} ${scheme}`, async () => {
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(path);
          await expectFooter(
            page,
            path === '/disclaimer.html' ? 'Disclaimer' : 'Privacy',
          );
          await expectAxeAndNoSidewaysScroll(page);
        });
      }
    }
  });
});
