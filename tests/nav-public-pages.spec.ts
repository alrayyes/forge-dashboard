import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1261: the changelog, disclaimer and privacy pages are open to visitors, so
// the layout never asked them for the nav counts. A signed-in user there saw
// every link, with no numbers.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `nav-public-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Nav Public');
}

function makePR(number: number, kind: string) {
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
    kind,
  };
}

function mockDashboard(
  page: Page,
  pullRequests: unknown[],
  openIssueCount: number,
) {
  return page.route(/\/api\/dashboard(\/refresh)?(\?.*)?$/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
        openIssueCount,
      }),
    }),
  );
}

const header = (page: Page, href: string) =>
  page.locator(`header nav a[href="${href}"]`);

for (const path of ['/changelog.html', '/disclaimer.html', '/privacy.html']) {
  test.describe(path, () => {
    test.beforeEach(async ({ page, request, baseURL }) => {
      await registerAndSignIn(page, request, baseURL);
    });

    test('a signed-in user gets the same nav as elsewhere: empty links hidden', async ({
      page,
    }) => {
      await mockDashboard(page, [makePR(1, 'regular')], 0);
      await page.goto(path);

      await expect(header(page, '/pull-requests.html')).toContainText('1');
      await expect(header(page, '/issues.html')).toHaveCount(0);
      await expect(header(page, '/releases.html')).toHaveCount(0);
      await expect(header(page, '/bots.html')).toHaveCount(0);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
    });

    test('links with something behind them show their number', async ({
      page,
    }) => {
      await mockDashboard(
        page,
        [makePR(1, 'regular'), makePR(10, 'release')],
        3,
      );
      await page.goto(path);

      await expect(header(page, '/issues.html')).toContainText('3');
      await expect(header(page, '/releases.html')).toContainText('1');
    });
  });
}

test('signed out, the changelog asks for no counts and still renders', async ({
  page,
}) => {
  let asked = false;
  await page.route(/\/api\/dashboard(\/refresh)?(\?.*)?$/, (route) => {
    asked = true;
    return route.abort();
  });
  await page.goto('/changelog.html');

  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  expect(asked).toBe(false);
});
