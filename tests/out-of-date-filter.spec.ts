import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { type PillGroup, quickPill } from './quick-pills-helper';
import { test } from './server-fixture';

// An Out of date badge on every pull request that is behind its base, and a
// quick filter that lists them. The page holds no rule of its own: the badge
// and the filter both read the `behind` field the rows already carry, and a
// pull request with nothing left to merge (`empty`) gets neither.

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
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

const PULLS = [
  makePR(1, { title: 'Alpha behind', behind: true }),
  makePR(2, { title: 'Bravo current' }),
  makePR(3, { title: 'Charlie empty behind', behind: true, empty: true }),
  makePR(4, { title: 'Delta draft behind', behind: true, draft: true }),
];

const BOTS = [
  makePR(11, {
    title: 'Dependabot behind',
    author: 'dependabot[bot]',
    kind: 'dependency',
    behind: true,
    allowedActions: [{ action: 'dependabot_rebase', allowed: true }],
  }),
  makePR(12, {
    title: 'Renovate behind',
    author: 'renovate[bot]',
    kind: 'dependency',
    behind: true,
    allowedActions: [{ action: 'renovate_rebase', allowed: true }],
  }),
  makePR(13, {
    title: 'Bot behind without a rebase',
    author: 'dependabot[bot]',
    kind: 'dependency',
    behind: true,
  }),
  makePR(14, {
    title: 'Bot up to date',
    author: 'dependabot[bot]',
    kind: 'dependency',
  }),
];

function mockDashboard(page: Page, pullRequests: unknown[]) {
  return page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
      }),
    }),
  );
}

const pill = (page: Page, name: string, group?: PillGroup) =>
  quickPill(page, name, group);
const rows = (page: Page) => page.locator('#pr-rows > .row');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('Out of date badge and quick filter', () => {
  test.beforeEach(async ({ page }) => {
    // The live stream would push the server's own, newer snapshot over the
    // mock, and the page drops the older one as stale.
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  });

  test('the overview leaves the badge off a behind pull request whose Update branch is live, and off one that is not behind (#3770)', async ({
    page,
  }) => {
    await mockDashboard(page, PULLS);
    await page.goto('/pull-requests.html');
    await expect(rows(page)).toHaveCount(4);

    const row = (title: string) => rows(page).filter({ hasText: title });
    await expect(
      row('Alpha behind').getByRole('button', { name: 'Update branch' }),
    ).toBeEnabled();
    for (const title of [
      'Alpha behind',
      'Bravo current',
      'Charlie empty behind',
      'Delta draft behind',
    ])
      await expect(row(title).locator('.attr-chip.behind')).toHaveCount(0);
  });

  test('the overview badges a behind pull request that has no live Update branch', async ({
    page,
  }) => {
    await mockDashboard(page, [
      makePR(1, {
        title: 'Alpha behind',
        behind: true,
        allowedActions: [{ action: 'close' }],
        status: null,
      }),
    ]);
    await page.goto('/pull-requests.html');
    const badge = rows(page).locator('.attr-chip.behind');
    await expect(badge).toHaveText('Out of date');
    await expect(badge.locator('svg')).toHaveCount(1);
  });

  test('the bots view badges Dependabot and Renovate with or without a rebase action', async ({
    page,
  }) => {
    await mockDashboard(page, BOTS);
    await page.goto('/bots.html');
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator('#pr-rows .attr-chip.behind')).toHaveCount(3);
    await expect(
      rows(page).filter({ hasText: 'Bot up to date' }).locator('.behind'),
    ).toHaveCount(0);
  });

  test('the badge is the warning colour and a screen reader hears it once', async ({
    page,
  }) => {
    await mockDashboard(page, BOTS);
    await page.goto('/bots.html');
    const badge = rows(page)
      .filter({ hasText: 'Bot behind without a rebase' })
      .locator('.attr-chip.behind');
    // The token is resolved in the same read as the badge, so a re-render
    // between the two cannot leave them out of step.
    await expect
      .poll(() =>
        badge.evaluate((el) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--warning)';
          document.body.appendChild(probe);
          const warning = getComputedStyle(probe).color;
          probe.remove();
          const s = getComputedStyle(el);
          return [s.color === warning, s.borderTopColor === warning];
        }),
      )
      .toEqual([true, true]);
    // The icon is decoration; the words are the one thing announced.
    await expect(badge.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(
      rows(page)
        .filter({ hasText: 'Bot behind without a rebase' })
        .getByText('Out of date'),
    ).toHaveCount(1);
  });

  test('the overview filter keeps only behind pull requests, with the count', async ({
    page,
  }) => {
    await mockDashboard(page, PULLS);
    await page.goto('/pull-requests.html');
    await pill(page, 'Out of date').click();

    await expect(pill(page, 'Out of date')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page.locator('.quick-pills[data-group="merge"] [aria-pressed="true"]'),
    ).toHaveCount(1);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#pr-count')).toHaveText('Showing 2 of 4');
    await expect(page.locator('#pr-rows')).toContainText('Alpha behind');
    await expect(page.locator('#pr-rows')).toContainText('Delta draft behind');
    await expect(page.locator('#pr-rows')).not.toContainText('Bravo current');
    await expect(page.locator('#pr-rows')).not.toContainText(
      'Charlie empty behind',
    );

    await pill(page, 'All', 'merge').click();
    await expect(rows(page)).toHaveCount(4);
  });

  test('the bots view filter narrows bot rows the same way', async ({
    page,
  }) => {
    await mockDashboard(page, BOTS);
    await page.goto('/bots.html');
    await pill(page, 'Out of date').click();
    await expect(rows(page)).toHaveCount(3);
    await expect(page.locator('#pr-rows')).not.toContainText('Bot up to date');
  });

  test('the choice survives a reload', async ({ page }) => {
    await mockDashboard(page, PULLS);
    await page.goto('/pull-requests.html');
    await pill(page, 'Out of date').click();
    await expect
      .poll(async () => {
        const resp = await page.request.get('/api/v1/settings/filter-state');
        return (await resp.json())?.pr?.merge;
      })
      .toBe('out-of-date');

    await page.reload();
    await expect(pill(page, 'Out of date')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(rows(page)).toHaveCount(2);
  });

  test('the pill is not offered when nothing is behind', async ({ page }) => {
    await mockDashboard(page, [
      makePR(2),
      makePR(3, { empty: true, behind: true }),
    ]);
    await page.goto('/pull-requests.html');
    await expect(pill(page, 'Out of date')).toBeHidden();
    // Left with only All, the group has nothing to offer and is hidden whole
    // (#3669).
    await expect(pill(page, 'All', 'merge')).toBeHidden();
  });

  test('has no axe-core violations in both themes with the badge and the pill active', async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(scheme, async () => {
        await page.emulateMedia({ colorScheme: scheme });
        await mockDashboard(page, PULLS);
        await page.goto('/pull-requests.html');
        await expect(rows(page)).toHaveCount(4);
        expect(
          (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
            .violations,
        ).toEqual([]);

        await pill(page, 'Out of date').click();
        await expect(rows(page)).toHaveCount(2);
        expect(
          (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
            .violations,
        ).toEqual([]);
        // The choice is saved: put it back so the next theme starts from All.
        await pill(page, 'All', 'merge').click();
        await expect(rows(page)).toHaveCount(4);
      });
    }
  });

  test('has no axe-core violations on the Bots page in both themes with the badge and the pill active', async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(scheme, async () => {
        await page.emulateMedia({ colorScheme: scheme });
        await mockDashboard(page, BOTS);
        await page.goto('/bots.html');
        await expect(rows(page)).toHaveCount(4);
        expect(
          (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
            .violations,
        ).toEqual([]);

        await pill(page, 'Out of date').click();
        await expect(rows(page)).toHaveCount(3);
        expect(
          (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
            .violations,
        ).toEqual([]);
        // The choice is saved: put it back so the next theme starts from All.
        await pill(page, 'All', 'merge').click();
        await expect(rows(page)).toHaveCount(4);
      });
    }
  });
});
