import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1458: the Branches item shows the total and how many default branches are
// failing, running and passing, as the pull request items do (#1439). The
// server counts them (`navCounts.branches`); the page only draws them.
// https://github.com/alrayyes/forge-dashboard/issues/1458

type Counts = {
  total: number;
  failed: number;
  running: number;
  passed: number;
};

const MIXED: Counts = { total: 7, failed: 2, running: 1, passed: 4 };

async function open(page: Page, branches: Counts) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
        navCounts: {
          branches,
          pullRequests: { total: 0, failed: 0, running: 0, passed: 0 },
          issues: { total: 0 },
          releases: { total: 0, failed: 0, running: 0, passed: 0 },
          bots: { total: 0, failed: 0, running: 0, passed: 0 },
        },
      }),
    }),
  );
  await page.goto('/settings.html');
}

const BRANCHES = '/';
const header = (page: Page) => page.locator(`header nav a[href="${BRANCHES}"]`);
const tab = (page: Page) => page.locator(`.bottom-nav a[href="${BRANCHES}"]`);

test.describe('the Branches nav pill shows failing, running and passing (#1458)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await register(page, request, baseURL);
  });

  test('shows the total, then failed, running and passed, each with its glyph', async ({
    page,
  }) => {
    await open(page, MIXED);
    const pill = header(page).locator('.nav-pills');

    await expect(pill).toHaveAttribute('aria-hidden', 'true');
    await expect(pill.locator('.nav-total')).toHaveText('7');
    await expect(pill.locator('.nav-failed')).toHaveText('2');
    await expect(pill.locator('.nav-running')).toHaveText('1');
    await expect(pill.locator('.nav-passed')).toHaveText('4');
    for (const kind of ['failed', 'running', 'passed']) {
      await expect(pill.locator(`.nav-${kind} svg`).first()).toBeAttached();
    }
  });

  test('a count of zero is not drawn, and no branches means no pill', async ({
    page,
  }) => {
    await open(page, { total: 5, failed: 0, running: 0, passed: 3 });
    const pill = header(page).locator('.nav-pills');
    await expect(pill.locator('.nav-passed')).toHaveText('3');
    await expect(pill.locator('.nav-failed')).toHaveCount(0);
    await expect(pill.locator('.nav-running')).toHaveCount(0);

    await open(page, { total: 0, failed: 0, running: 0, passed: 0 });
    await expect(header(page).locator('.nav-pills')).toHaveCount(0);
  });

  test('on a 360px phone every tab fits and the pill stays inside its tab', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, MIXED);
    await expect(tab(page).locator('.nav-pills')).toBeVisible();

    const boxes = await page
      .locator('.bottom-nav .bottom-nav-link')
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const p = el.querySelector('.nav-pills')?.getBoundingClientRect();
          return {
            right: r.right,
            height: r.height,
            inside: p ? p.left >= r.left - 1 && p.right <= r.right + 1 : true,
          };
        }),
      );
    for (const b of boxes) {
      expect(b.right).toBeLessThanOrEqual(361);
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.inside).toBe(true);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe-core violations in the ${scheme} theme, on desktop and on a phone`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, MIXED);

      for (const size of [
        { width: 1280, height: 800 },
        { width: 360, height: 740 },
      ]) {
        await page.setViewportSize(size);
        await expect(header(page).locator('.nav-pills')).toHaveCount(1);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      }
    });
  }
});

async function register(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `nav-branches-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Nav Branches');
}
