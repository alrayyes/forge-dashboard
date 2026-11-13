import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { type PillGroup, quickPill } from './quick-pills-helper';
import { test } from './server-fixture';

// #1215: a Conflicts quick filter lists only the pull requests whose
// `mergeStatus` is `conflicting`, so they can be fixed in one pass. The page
// holds no rule of its own: it reads the field the rows already show.

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

const MIXED = [
  makePR(1, { title: 'Conflicts with main', mergeStatus: 'conflicting' }),
  // On the other forge, so the forge pills have a real choice to offer.
  makePR(2, {
    title: 'Merges cleanly',
    forge: 'forgejo',
    mergeStatus: 'mergeable',
  }),
  makePR(3, { title: 'Status not known yet', mergeStatus: 'unknown' }),
  makePR(4, {
    title: 'A draft that conflicts',
    draft: true,
    mergeStatus: 'conflicting',
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

test.describe('Conflicts quick filter (#1215)', () => {
  test.beforeEach(async ({ page }) => {
    // The live stream would push the server's own, newer snapshot over the
    // mock, and the page drops the older one as stale.
    await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  });

  test('lists only the conflicting pull requests, a draft that conflicts included, with no axe-core violations', async ({
    page,
  }) => {
    await mockDashboard(page, MIXED);
    await page.goto('/pull-requests.html');
    await expect(rows(page)).toHaveCount(4);

    await pill(page, 'Conflicting').click();

    await expect(pill(page, 'Conflicting')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(pill(page, 'All', 'merge')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(
      page.locator('.quick-pills[data-group="merge"] [aria-pressed="true"]'),
    ).toHaveCount(1);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#pr-rows')).toContainText('Conflicts with main');
    await expect(page.locator('#pr-rows')).toContainText(
      'A draft that conflicts',
    );
    await expect(page.locator('#pr-rows')).not.toContainText('Merges cleanly');
    await expect(page.locator('#pr-rows')).not.toContainText(
      'Status not known yet',
    );

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('choosing a pill, then All in its group, clears it', async ({
    page,
  }) => {
    await mockDashboard(page, MIXED);
    await page.goto('/pull-requests.html');
    await pill(page, 'Conflicting').click();
    await expect(pill(page, 'Conflicting')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await pill(page, 'All', 'merge').click();
    await expect(pill(page, 'Conflicting')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(rows(page)).toHaveCount(4);
  });

  test('it survives a reload like the other quick filters', async ({
    page,
  }) => {
    await mockDashboard(page, MIXED);
    await page.goto('/pull-requests.html');
    await pill(page, 'Conflicting').click();
    // The click saves in the background; a reload before it lands would load
    // the older copy (#900).
    await expect
      .poll(async () => {
        const resp = await page.request.get('/api/v1/settings/filter-state');
        return (await resp.json())?.pr?.merge;
      })
      .toBe('conflicting');

    await page.reload();
    await expect(pill(page, 'Conflicting')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(rows(page)).toHaveCount(2);
  });

  test('when the conflicts clear while the pill is active, the pill stays and the list says nothing matches', async ({
    page,
  }) => {
    await mockDashboard(page, MIXED);
    await page.goto('/pull-requests.html');
    await pill(page, 'Conflicting').click();
    await expect(rows(page)).toHaveCount(2);
    // The click saves in the background; wait for it before the data changes.
    await expect
      .poll(async () => {
        const resp = await page.request.get('/api/v1/settings/filter-state');
        return (await resp.json())?.pr?.merge;
      })
      .toBe('conflicting');

    // Nothing conflicts any more. The pill isn't offered to pick, but the
    // active one stays (#1427), so it can be seen and cleared.
    await page.unroute('**/api/v1/dashboard*');
    await mockDashboard(page, [
      makePR(2),
      makePR(3, { mergeStatus: 'unknown' }),
    ]);
    await page.reload();

    await expect(pill(page, 'Conflicting')).toBeVisible();
    await expect(pill(page, 'Conflicting')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('#pr-no-results')).toBeVisible();
    await pill(page, 'All', 'merge').click();
    await expect(rows(page)).toHaveCount(2);
  });

  test('a pill nothing matches is not offered', async ({ page }) => {
    await mockDashboard(page, [
      makePR(2),
      makePR(3, { mergeStatus: 'unknown' }),
    ]);
    await page.goto('/pull-requests.html');

    await expect(pill(page, 'Conflicting')).toBeHidden();
    // Every row is on one forge and no other pill backs any, so only All is
    // left, and a group with only All is hidden whole (#3669).
    await expect(page.locator('.filter-bar .quick-pills:visible')).toHaveCount(
      0,
    );
  });
});
