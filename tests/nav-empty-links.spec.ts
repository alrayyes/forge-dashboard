import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { navCountsFor } from './nav-counts-helper';
import { registerViaInvite } from './register-helper';

// #1228: the Issues, Releases and Bots links are in the navigation only
// while they have something to show. A count of null (not loaded yet) is not
// zero, the page you are on keeps its link, and Pull requests always show.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `nav-empty-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Nav Empty');
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

const release = makePR(10, {
  title: 'chore(main): release 1.0.0',
  author: 'release-please[bot]',
  kind: 'release',
});
const bot = makePR(20, {
  title: 'Bump foo from 1 to 2',
  author: 'dependabot',
  kind: 'dependency',
});

type Snapshot = { pullRequests: unknown[]; openIssueCount: number };

function mockDashboard(
  page: Page,
  state: Snapshot,
  options: { gate?: Promise<void> } = {},
) {
  return page.route(
    /\/api\/dashboard(\/refresh)?(\?.*)?$/,
    async (route: Route) => {
      if (options.gate) await options.gate;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: state.pullRequests,
          issues: [],
          openIssueCount: state.openIssueCount,
          navCounts: navCountsFor(state.pullRequests, state.openIssueCount),
        }),
      });
    },
  );
}

const header = (page: Page, href: string) =>
  page.locator(`header nav a[href="${href}"]`);
const tab = (page: Page, href: string) =>
  page.locator(`.bottom-nav a[href="${href}"]`);
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const LINKS = ['/issues.html', '/releases.html', '/bots.html'];

test.describe('empty pages leave the navigation (#1228)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    // The live stream would push the server's own, newer snapshot over the
    // mock, and the page drops the older one as stale.
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
  });

  test('with nothing to show, the three links are gone from the header and the tab bar, and Pull requests stays', async ({
    page,
  }) => {
    await mockDashboard(page, { pullRequests: [makePR(1)], openIssueCount: 0 });
    await page.goto('/settings.html');
    await expect(header(page, '/pull-requests.html')).toBeVisible();
    // Counts are known once the pull request badge has its number.
    await expect(
      header(page, '/pull-requests.html').locator('.nav-total'),
    ).toHaveText('1');

    for (const href of LINKS) {
      await expect(header(page, href)).toHaveCount(0);
      await expect(tab(page, href)).toHaveCount(0);
    }
    for (const href of [
      '/',
      '/insights.html',
      '/webhooks.html',
      '/settings.html',
    ]) {
      await expect(header(page, href)).toHaveCount(1);
      await expect(tab(page, href)).toHaveCount(1);
    }
  });

  test('each link shows on its own count', async ({ page }) => {
    await mockDashboard(page, {
      pullRequests: [makePR(1), release],
      openIssueCount: 0,
    });
    await page.goto('/settings.html');
    await expect(header(page, '/releases.html')).toBeVisible();
    await expect(header(page, '/issues.html')).toHaveCount(0);
    await expect(header(page, '/bots.html')).toHaveCount(0);
    await expect(tab(page, '/releases.html')).toHaveCount(1);

    await mockDashboard(page, {
      pullRequests: [bot],
      openIssueCount: 3,
    });
    await page.goto('/insights.html');
    await expect(header(page, '/bots.html')).toBeVisible();
    await expect(header(page, '/issues.html')).toBeVisible();
    await expect(header(page, '/releases.html')).toHaveCount(0);
  });

  test('while the counts are not loaded the links stay, then go once they say zero', async ({
    page,
  }) => {
    // The snapshot is held until the test lets it go, so the "not loaded yet"
    // moment lasts exactly as long as the assertions need.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mockDashboard(
      page,
      { pullRequests: [makePR(1)], openIssueCount: 0 },
      { gate },
    );
    await page.goto('/settings.html');
    for (const href of LINKS) await expect(header(page, href)).toHaveCount(1);

    release();
    await expect(
      header(page, '/pull-requests.html').locator('.nav-total'),
    ).toHaveText('1');
    for (const href of LINKS) await expect(header(page, href)).toHaveCount(0);
  });

  test('the page you are on keeps its link at zero, marked current, and loses it when you leave', async ({
    page,
  }) => {
    await mockDashboard(page, { pullRequests: [makePR(1)], openIssueCount: 0 });
    await page.goto('/releases.html');
    await expect(
      header(page, '/pull-requests.html').locator('.nav-total'),
    ).toHaveText('1');
    await expect(header(page, '/releases.html')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('#pr-empty')).toBeVisible();

    await page.goto('/settings.html');
    await expect(
      header(page, '/pull-requests.html').locator('.nav-total'),
    ).toHaveText('1');
    await expect(header(page, '/releases.html')).toHaveCount(0);
  });

  test('a count that rises brings its link in without a reload', async ({
    page,
  }) => {
    const state: Snapshot = { pullRequests: [makePR(1)], openIssueCount: 0 };
    await mockDashboard(page, state);
    await page.goto('/pull-requests.html');
    await expect(
      header(page, '/pull-requests.html').locator('.nav-total'),
    ).toHaveText('1');
    await expect(header(page, '/releases.html')).toHaveCount(0);

    state.pullRequests = [makePR(1), release];
    await page.locator('#force-refresh-button').click();
    await expect(header(page, '/releases.html')).toBeVisible();
  });

  test('a page typed into the address bar with a count of zero still opens with its own empty state', async ({
    page,
  }) => {
    await mockDashboard(page, { pullRequests: [makePR(1)], openIssueCount: 0 });
    await page.goto('/bots.html');
    await expect(page.locator('#pr-empty')).toContainText(
      'No bot pull requests',
    );
    await page.goto('/issues.html');
    await expect(page.locator('#issue-empty')).toBeVisible();
  });

  test('has no axe-core violations with and without the links, and the tab bar fits at 390px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state: Snapshot = { pullRequests: [makePR(1)], openIssueCount: 0 };
    await mockDashboard(page, state);
    await page.goto('/settings.html');
    await expect(
      header(page, '/pull-requests.html').locator('.nav-total'),
    ).toHaveText('1');
    expect(
      (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
    ).toEqual([]);

    state.pullRequests = [makePR(1), release, bot];
    state.openIssueCount = 2;
    await mockDashboard(page, state);
    await page.goto('/settings.html');
    await expect(tab(page, '/bots.html')).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
    ).toEqual([]);
    const inside = await page
      .locator('.bottom-nav .bottom-nav-link')
      .evaluateAll((els) =>
        els.every((el) => el.getBoundingClientRect().right <= innerWidth + 1),
      );
    expect(inside).toBe(true);
  });
});
