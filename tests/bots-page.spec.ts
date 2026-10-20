import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { navCountsFor } from './nav-counts-helper';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The Bots page: Dependabot and Renovate pull requests (the server's
// `kind: dependency`) with their own overview and count, and none of them on
// the pull request page.

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

const bump = (number: number, author = 'dependabot') =>
  makePR(number, {
    title: `Bump package-${number} from 1.0.0 to 1.0.1`,
    author,
    kind: 'dependency',
  });

const release = (number: number) =>
  makePR(number, {
    title: `chore(main): release 0.${number}.0`,
    author: 'release-please[bot]',
    kind: 'release',
  });

const SNAPSHOT = [
  makePR(1),
  makePR(2),
  bump(20),
  bump(21, 'renovate[bot]'),
  bump(22),
  // Behind, so its Out of date pill is part of the scans below.
  { ...bump(23), behind: true },
  release(30),
];

function mockDashboard(page: Page, pullRequests: unknown[]) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        navCounts: navCountsFor(pullRequests, 0),
      }),
    }),
  );
}

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('Bots page (#1192)', () => {
  // Only reads mocked data, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // The live stream would push the server's own, newer snapshot over the
    // mock, and the page drops the older one as stale.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
  });

  test('lists only dependency pull requests, from both bots', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/bots.html');

    await expect(page.locator('#pr-rows > .row')).toHaveCount(4);
    await expect(page.locator('#pr-rows')).toContainText('package-20');
    await expect(page.locator('#pr-rows')).toContainText('package-21');
    await expect(page.locator('#pr-rows')).not.toContainText('Pull request 1');
    await expect(page.locator('#pr-rows')).not.toContainText('release 0.30');
    await expect(page.getByRole('heading', { name: 'Bots' })).toBeVisible();
    await expect(page).toHaveTitle(/Bots/);
  });

  test('rows keep their actions', async ({ page }) => {
    await mockDashboard(page, [bump(20)]);
    await page.goto('/bots.html');
    const row = page.locator('#pr-rows > .row').first();
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toBeVisible();
  });

  test('says there is nothing to review when no bot pull request is open', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR(1)]);
    await page.goto('/bots.html');
    await expect(page.locator('#pr-empty')).toBeVisible();
    await expect(page.locator('#pr-empty')).toContainText(
      'No bot pull requests are open',
    );
  });

  test('the pull request page lists no bot or release pull requests, and has no Bot PRs filter', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/pull-requests.html');

    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    await expect(page.locator('#pr-count')).toHaveText('2 open');
    await expect(page.locator('#pr-rows')).not.toContainText('package-20');
    await expect(
      page
        .locator('.quick-pills')
        .getByRole('button', { name: 'Bot PRs', exact: true }),
    ).toHaveCount(0);
  });

  test('rows leave out the Bot pill but keep their other chips', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/bots.html');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(4);

    await expect(page.locator('#pr-rows .attr-chip.bot')).toHaveCount(0);
    await expect(page.locator('#pr-rows')).not.toContainText(/\bBot\b/);
    // The pill is the only thing dropped: the behind row says so still.
    await expect(
      page.locator('#pr-rows .attr-cluster .attr-chip', {
        hasText: 'Out of date',
      }),
    ).toHaveCount(1);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`rows without the pill have no axe violations in ${scheme} and fit at 390px`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockDashboard(page, SNAPSHOT);
      await page.goto('/bots.html');
      await expect(page.locator('#pr-rows > .row')).toHaveCount(4);
      await expect(page.locator('#pr-rows .attr-chip.bot')).toHaveCount(0);
      expect(
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
      ).toEqual([]);

      await page.setViewportSize({ width: 390, height: 844 });
      const fits = await page
        .locator('#pr-rows .row')
        .evaluateAll((els) =>
          els.map((el) => el.scrollWidth <= el.clientWidth + 1),
        );
      expect(fits.every(Boolean)).toBe(true);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test('has no axe-core violations and no horizontal scroll at desktop and 390px', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/bots.html');
    await expect(page.locator('#pr-rows > .row')).toHaveCount(4);
    expect(
      (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations,
    ).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations,
    ).toEqual([]);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // Seven tabs have to fit in one row of the bar.
    const tabs = await page
      .locator('.bottom-nav .bottom-nav-link')
      .evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect().right <= innerWidth + 1),
      );
    expect(tabs.every(Boolean)).toBe(true);
  });

  test('has no horizontal overflow at 761 px (#1899)', async ({ page }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/bots.html');
    await page.setViewportSize({ width: 761, height: 844 });

    await expect(page.locator('#pr-rows .row')).toHaveCount(4);

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const rows = page.locator('#pr-rows .row');
    const fits = await rows.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().right <= innerWidth + 1),
    );
    expect(fits.every(Boolean)).toBe(true);

    // Every title text and status chip must be fully visible.
    const chips = page.locator('#pr-rows .row .status-cell');
    const chipFits = await chips.evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        return rect.right <= innerWidth + 1 && rect.width > 0;
      }),
    );
    expect(chipFits.every(Boolean)).toBe(true);

    expect(
      (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations,
    ).toEqual([]);
  });

  test('the narrow layout drops the author, created and updated columns up to 1103 px, not past it (#1899)', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/bots.html');
    const author = page.locator('#pr-rows .row .author').first();
    await page.setViewportSize({ width: 1103, height: 844 });
    await expect(author).toBeHidden();
    await page.setViewportSize({ width: 1104, height: 844 });
    await expect(author).toBeVisible();
  });

  // 1103 px is the last width the narrow layout covers and 1104 px the first
  // the full grid covers. 949 and 950 px are where the full grid's fixed
  // columns alone stop fitting. The other widths sit inside the range.
  for (const width of [768, 800, 949, 950, 1103, 1104]) {
    test(`has no horizontal overflow at ${width} px (#1899)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await mockDashboard(page, SNAPSHOT);
      await page.goto('/bots.html');
      await expect(page.locator('#pr-rows .row')).toHaveCount(4);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal scroll at ${width}px`).toBeLessThanOrEqual(
        0,
      );

      // The page itself may not scroll while a row still spills out of it.
      const spill = await page
        .locator('#pr-rows .row')
        .evaluateAll((els) => els.map((el) => el.scrollWidth - el.clientWidth));
      expect(
        spill.every((px) => px <= 0),
        `a row overflows its own box at ${width}px`,
      ).toBe(true);

      // A title column squeezed to nothing fits the page and is no use.
      const title = await page
        .locator('#pr-rows .row .title')
        .first()
        .boundingBox();
      expect(
        title?.width,
        `the title is too narrow at ${width}px`,
      ).toBeGreaterThanOrEqual(100);
    });
  }
});
