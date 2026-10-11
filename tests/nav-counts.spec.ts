import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// The nav shows how many are waiting, like Issues does: pull requests on the
// Home item, release pull requests on Releases. Release pull requests are not
// on the pull request page at all; they live on the Releases page.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `nav-counts-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Nav Counts');
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

const release = (number: number, version: string) =>
  makePR(number, {
    title: `chore(main): release ${version}`,
    author: 'release-please[bot]',
    kind: 'release',
  });

function mockDashboard(page: Page, pullRequests: unknown[], issues = 0) {
  return page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
        openIssueCount: issues,
      }),
    }),
  );
}

const SNAPSHOT = [
  makePR(1),
  makePR(2),
  makePR(3, { author: 'dependabot', kind: 'dependency' }),
  release(10, '0.74.2'),
  release(11, '1.12.0'),
];

const badge = (page: Page, nav: 'header' | '.bottom-nav', link: string) =>
  page.locator(nav).locator(`a[href="${link}"] .nav-badge`);

test.describe('nav counts and the pull request page without releases', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    // The live stream would push the server's own, newer snapshot over the
    // mock, and the page drops the older one as stale.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
  });

  test('the pull request page lists no release pull requests', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/');

    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    await expect(page.locator('#pr-rows')).not.toContainText('release 0.74.2');
    await expect(page.locator('#stat-prs')).toHaveText('2');
  });

  test('Home shows the pull request count and Releases the release count', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT, 4);
    await page.goto('/');

    await expect(badge(page, 'header', '/')).toHaveText('2');
    await expect(badge(page, 'header', '/releases.html')).toHaveText('2');
    await expect(badge(page, 'header', '/issues.html')).toHaveText('4');
  });

  test('the counts are the same on the Releases page and on pages with no board', async ({
    page,
  }) => {
    await mockDashboard(page, SNAPSHOT);
    for (const path of ['/releases.html', '/settings.html', '/insights.html']) {
      await page.goto(path);
      await expect(badge(page, 'header', '/')).toHaveText('2');
      await expect(badge(page, 'header', '/releases.html')).toHaveText('2');
    }
  });

  test('the phone tab bar shows both counts, and names carry the visible words', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockDashboard(page, SNAPSHOT);
    await page.goto('/');

    await expect(badge(page, '.bottom-nav', '/')).toHaveText('2');
    await expect(badge(page, '.bottom-nav', '/releases.html')).toHaveText('2');
    await expect(
      page.locator('.bottom-nav').getByRole('link', { name: /Home/ }),
    ).toHaveAccessibleName(/2.*Home/);
    await expect(
      page.locator('.bottom-nav').getByRole('link', { name: /Releases/ }),
    ).toHaveAccessibleName(/2.*Releases/);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });

  test('a release count of zero still shows', async ({ page }) => {
    await mockDashboard(page, [makePR(1)]);
    await page.goto('/');
    await expect(badge(page, 'header', '/')).toHaveText('1');
    await expect(badge(page, 'header', '/releases.html')).toHaveText('0');
  });
});
