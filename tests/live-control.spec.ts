import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { mainBranchPageOf } from './nav-counts-helper';
import { test } from './server-fixture';

// One live control (status, updated time, Pause, refresh) leads the right-hand
// group of every list card header. Design: docs/ui-audit-2026-11/stitch/
// live-control-live-desktop-1280.png, live-control-paused-desktop-1280.png and
// live-control-bots-desktop-1280.png.
// https://github.com/alrayyes/forge-dashboard/issues/3699

const SIZES = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

const ago = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString();

async function mockDashboard(page: Page, generatedAt = ago(12)) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt,
        readIntervalSeconds: 60,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
        firstRefreshDone: true,
      }),
    }),
  );
}

async function mockBranches(page: Page) {
  await mockDashboard(page);
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mainBranchPageOf(['passed', 'failed']),
        generatedAt: ago(12),
      }),
    }),
  );
}

const CARDS = [
  {
    name: 'Pull requests',
    path: '/pull-requests.html',
    card: 'Open pull requests',
  },
  { name: 'Bots', path: '/bots.html', card: 'Open pull requests' },
  { name: 'Issues', path: '/issues.html', card: 'Open issues' },
  { name: 'Releases', path: '/releases.html', card: 'Open pull requests' },
];

const control = (page: Page) => page.locator('.live-control');

for (const c of CARDS) {
  test.describe(`${c.name} live control (#3699)`, () => {
    test('is one control in the card header: Live, time, Pause, refresh', async ({
      page,
    }) => {
      await mockDashboard(page);
      await page.goto(c.path);
      const live = control(page);
      await expect(live).toHaveCount(1);
      await expect(live).toContainText('Live');
      await expect(live).toContainText(/updated \d+s ago/);
      await expect(live.getByRole('button', { name: /Pause/ })).toBeVisible();
      await expect(
        live.getByRole('button', { name: 'Refresh now' }),
      ).toBeVisible();
      // First in the right-hand group of the card header.
      const first = page.locator(
        `section[aria-label="${c.card}"] .board-head-controls > :first-child`,
      );
      await expect(first).toHaveClass(/live-control/);
    });

    test('paused reads Paused and Resume, and the old pieces are gone', async ({
      page,
    }) => {
      await mockDashboard(page);
      await page.goto(c.path);
      await control(page).getByRole('button', { name: /Pause/ }).click();
      await expect(control(page)).toContainText('Paused');
      await expect(control(page)).toContainText(/updated \d+s ago/);
      await expect(
        control(page).getByRole('button', { name: /Resume/ }),
      ).toBeVisible();
      await expect(page.getByText('Refreshed', { exact: false })).toHaveCount(
        0,
      );
      await expect(page.locator('.updates-bar')).toHaveCount(0);
      await expect(page.locator('#updates-paused-hint')).toHaveCount(0);
      await control(page)
        .getByRole('button', { name: /Resume/ })
        .click();
      await expect(control(page)).toContainText('Live');
    });

    test('is accessible at 360, 390 and 1280', async ({ page }) => {
      await mockDashboard(page);
      await page.goto(c.path);
      for (const size of SIZES) {
        await page.setViewportSize(size);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations, `${size.width}px`).toEqual([]);
        if (size.width < 761) {
          for (const b of await control(page).getByRole('button').all()) {
            const box = await b.boundingBox();
            expect(
              box?.height,
              `${size.width}px target`,
            ).toBeGreaterThanOrEqual(44);
            expect(box?.width, `${size.width}px target`).toBeGreaterThanOrEqual(
              44,
            );
          }
        }
      }
    });
  });
}

test.describe('Branches live control (#3699)', () => {
  test('leads the header with Live, time, Pause and refresh', async ({
    page,
  }) => {
    await mockBranches(page);
    await page.goto('/');
    const live = control(page);
    await expect(live).toHaveCount(1);
    await expect(live).toContainText('Live');
    await expect(live).toContainText(/updated \d+s ago/);
    await live.getByRole('button', { name: /Pause/ }).click();
    await expect(live).toContainText('Paused');
    await expect(live.getByRole('button', { name: /Resume/ })).toBeVisible();
  });

  test('is accessible at 360, 390 and 1280', async ({ page }) => {
    await mockBranches(page);
    await page.goto('/');
    await expect(control(page)).toBeVisible();
    for (const size of SIZES) {
      await page.setViewportSize(size);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${size.width}px`).toEqual([]);
    }
  });
});
