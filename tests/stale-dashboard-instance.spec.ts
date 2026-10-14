import { expect, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// #1259: a page opened at /releases.html is a hard load, and its Pull requests link
// ("/pull-requests.html") is then a client-side navigation. The Releases board was destroyed
// but its poll kept running, and drew release pull requests onto the pull request page.

// The test mocks /api/dashboard and writes nothing per user, so it starts from
// the shared session instead of registering a user (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

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

const SNAPSHOT = [
  makePR(1),
  makePR(2),
  makePR(10, {
    title: 'chore(main): release 0.74.2',
    author: 'release-please[bot]',
    kind: 'release',
  }),
];

test('the pull request page stays free of release pull requests after leaving Releases', async ({
  page,
}) => {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  let polls = 0;
  await page.route(/\/api\/dashboard(\/refresh)?(\?.*)?$/, (route: Route) => {
    polls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date(Date.now() + polls * 1000).toISOString(),
        readIntervalSeconds: 1,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: SNAPSHOT,
        issues: [],
      }),
    });
  });
  await page.clock.install();

  await page.goto('/releases.html');
  await expect(page.locator('#pr-rows')).toContainText('release 0.74.2');

  await page.locator('header .app-nav a[href="/pull-requests.html"]').click();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  const pollsOnArrival = polls;

  // Several of the old page's poll intervals.
  await page.clock.runFor(5000);

  await expect(page.locator('#pr-rows')).not.toContainText('release 0.74.2');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  // One live page polls once a second, not two.
  expect(polls - pollsOnArrival).toBeLessThanOrEqual(5);
});
