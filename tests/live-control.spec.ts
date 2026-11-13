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

// The time is when the rows on screen were read, so it holds still while
// updates are held and moves to the newest snapshot on Resume (#3699).
async function stubStream(page: Page) {
  await page.addInitScript(() => {
    class StubEventSource {
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor() {
        (window as unknown as { __es: StubEventSource }).__es = this;
      }
      close() {}
      addEventListener() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource =
      StubEventSource;
    (window as unknown as { __push: (d: unknown) => void }).__push = (data) =>
      (window as unknown as { __es: StubEventSource }).__es.onmessage?.({
        data: JSON.stringify(data),
      });
  });
}

const snap = (generatedAt: string) => ({
  generatedAt,
  readIntervalSeconds: 60,
  forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
  pullRequests: [],
  issues: [],
  openIssueCount: 0,
  repos: [],
  hiddenDrafts: 0,
  firstRefreshDone: true,
});

async function pushSnapshot(page: Page, generatedAt: string) {
  await page.waitForFunction(
    () =>
      (window as unknown as { __es?: { onmessage: unknown } }).__es
        ?.onmessage != null,
  );
  await page.evaluate(
    (d) => (window as unknown as { __push: (x: unknown) => void }).__push(d),
    snap(generatedAt),
  );
}

for (const c of CARDS) {
  test.describe(`${c.name} updated time while paused (#3699)`, () => {
    test('holds still while paused and moves on Resume', async ({ page }) => {
      await stubStream(page);
      await mockDashboard(page, ago(7200));
      await page.goto(c.path);
      const live = control(page);
      await expect(live).toContainText('updated 2h ago');
      await live.getByRole('button', { name: /Pause/ }).click();
      await pushSnapshot(page, ago(5));
      // Give a wrongly advanced time a moment to show.
      await page.waitForTimeout(400);
      await expect(live).toContainText('updated 2h ago');
      await live.getByRole('button', { name: /Resume/ }).click();
      await expect(live).toContainText(/updated \d+s ago/);
    });

    test('keeps counting from the old time when a refresh fails', async ({
      page,
    }) => {
      await mockDashboard(page, ago(7200));
      await page.route('**/api/v1/dashboard/refresh*', (route: Route) =>
        route.fulfill({ status: 500, body: 'nope' }),
      );
      await page.goto(c.path);
      const live = control(page);
      await expect(live).toContainText('updated 2h ago');
      await live.getByRole('button', { name: 'Refresh now' }).click();
      await expect(page.getByText(/Could not refresh/).first()).toBeVisible();
      await expect(live).toContainText('updated 2h ago');
    });
  });
}

// Main branches holds a page that arrives while paused, draws it on Resume,
// and draws a refresh the user asked for at once (#3699).
test.describe('Branches pause and refresh (#3699)', () => {
  const rows = (page: Page) => page.locator('[data-testid="main-branch-row"]');
  const pageOf = (statuses: string[], generatedAt: string) => ({
    ...mainBranchPageOf(statuses),
    generatedAt,
  });

  async function open(page: Page) {
    await stubStream(page);
    await mockDashboard(page);
    let current = pageOf(['passed', 'failed'], ago(3600));
    await page.route('**/api/v1/main-branches', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(current),
      }),
    );
    await page.goto('/');
    await expect(rows(page)).toHaveCount(2);
    return {
      serve: (next: typeof current) => {
        current = next;
      },
    };
  }

  const pushPage = async (page: Page, next: unknown) => {
    await page.waitForFunction(
      () =>
        (window as unknown as { __es?: { onmessage: unknown } }).__es
          ?.onmessage != null,
    );
    await page.evaluate(
      (d) => (window as unknown as { __push: (x: unknown) => void }).__push(d),
      { ...snap(ago(5)), mainBranchPage: next },
    );
  };

  test('the control is first in the header', async ({ page }) => {
    await open(page);
    await expect(page.locator('.mb-header > :first-child')).toHaveText(
      'Main branches',
    );
    await expect(
      page.locator('.mb-header-controls > :first-child'),
    ).toHaveClass(/live-control/);
  });

  test('a page that arrives while paused waits for Resume', async ({
    page,
  }) => {
    await open(page);
    const live = control(page);
    await expect(live).toContainText('updated 1h ago');
    await live.getByRole('button', { name: /Pause/ }).click();
    await expect(page.locator('#list-updates-status')).toHaveText(
      'Live updates paused',
    );
    await pushPage(page, pageOf(['passed', 'failed', 'running'], ago(5)));
    await page.waitForTimeout(400);
    await expect(rows(page)).toHaveCount(2);
    await expect(live).toContainText('updated 1h ago');
    await live.getByRole('button', { name: /Resume/ }).click();
    await expect(rows(page)).toHaveCount(3);
    await expect(live).toContainText(/updated \d+s ago/);
  });

  test('a refresh the user asks for draws at once, even paused', async ({
    page,
  }) => {
    const server = await open(page);
    await control(page).getByRole('button', { name: /Pause/ }).click();
    server.serve(pageOf(['passed', 'failed', 'running'], ago(5)));
    await control(page).getByRole('button', { name: 'Refresh now' }).click();
    await expect(rows(page)).toHaveCount(3);
  });

  test('a press while refreshing is ignored and focus stays', async ({
    page,
  }) => {
    await open(page);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/v1/main-branches', async (route: Route) => {
      calls++;
      await gate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(pageOf(['passed', 'failed'], ago(2))),
      });
    });
    const refresh = control(page).getByRole('button', { name: 'Refresh now' });
    await refresh.focus();
    await refresh.press('Enter');
    await expect(refresh).toHaveAttribute('aria-disabled', 'true');
    await expect(refresh).toHaveClass(/is-refreshing/);
    await refresh.press('Enter');
    await expect(refresh).toBeFocused();
    release();
    await expect(refresh).not.toHaveAttribute('aria-disabled', 'true');
    expect(calls).toBe(1);
  });

  test('a failed refresh is announced and keeps the rows and the time', async ({
    page,
  }) => {
    await open(page);
    await page.route('**/api/v1/main-branches', (route: Route) =>
      route.fulfill({ status: 500, body: 'nope' }),
    );
    await control(page).getByRole('button', { name: 'Refresh now' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Could not refresh' }),
    ).toBeVisible();
    await expect(rows(page)).toHaveCount(2);
    await expect(control(page)).toContainText('updated 1h ago');
  });
});

test('a refresh that fails with no rows on screen raises one alert, not two', async ({
  page,
}) => {
  await mockDashboard(page);
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({ status: 500, body: 'nope' }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await control(page).getByRole('button', { name: 'Refresh now' }).click();
  await expect(page.getByRole('alert')).toHaveCount(1);
});
