import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// The Bots page: Dependabot and Renovate pull requests (the server's
// `kind: dependency`) with their own overview and count, and none of them on
// the pull request page.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `bots-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Bots Test');
}

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
      }),
    }),
  );
}

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const badge = (page: Page, nav: 'header' | '.bottom-nav', link: string) =>
  page.locator(nav).locator(`a[href="${link}"] .nav-badge`);

test.describe('Bots page (#1192)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
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
    await page.goto('/');

    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    await expect(page.locator('#stat-prs')).toHaveText('2');
    await expect(page.locator('#pr-rows')).not.toContainText('package-20');
    await expect(
      page
        .locator('.quick-pills')
        .getByRole('button', { name: 'Bot PRs', exact: true }),
    ).toHaveCount(0);
  });

  test('the nav counts each: Home without bots, Bots on its own, in header and tab bar', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/');
    await expect(badge(page, 'header', '/')).toHaveText('2');
    await expect(badge(page, 'header', '/releases.html')).toHaveText('1');
    await expect(badge(page, 'header', '/bots.html')).toHaveText('4');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(badge(page, '.bottom-nav', '/bots.html')).toHaveText('4');
    await expect(
      page.locator('.bottom-nav').getByRole('link', { name: /Bots/ }),
    ).toHaveAccessibleName(/4.*Bots/);
  });

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
});
