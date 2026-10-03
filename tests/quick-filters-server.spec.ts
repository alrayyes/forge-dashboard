import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #807: Ready to Merge and Needs Review list what the server says they are,
// from `readyToMerge` and `needsReview` on each pull request. Each pull
// request here states the flags itself, in a way that disagrees with what
// its raw fields would have said, so passing proves the page holds no copy
// of the definitions.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `quick-filters-server-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Quick Filters');
}

function pr(number: number, over: Record<string, unknown>) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `PR ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryan',
    draft: false,
    ci: 'success',
    mergeStatus: 'mergeable',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    readyToMerge: false,
    needsReview: false,
    ...over,
  };
}

// Raw fields say "ready" for 1 and not for 2; the flags say the opposite.
const PRS = [
  pr(1, { title: 'Raw ready, server no', readyToMerge: false }),
  pr(2, {
    title: 'Raw failing, server yes',
    ci: 'failure',
    mergeStatus: 'blocked',
    draft: true,
    readyToMerge: true,
  }),
  pr(3, {
    title: 'Server wants a review',
    review: { decision: 'approved', approvals: 1, requestedReviewers: 0 },
    needsReview: true,
  }),
  pr(4, {
    title: 'Raw review required, server no',
    review: {
      decision: 'review_required',
      approvals: 0,
      requestedReviewers: 1,
    },
    needsReview: false,
  }),
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.reload();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const titles = (page: Page) => page.locator('#pr-rows > .row .title-text');

test.describe('the quick filters follow the server (#807)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    await open(page);
  });

  test('Ready to Merge lists the pull requests the server marks ready', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Ready to Merge' }).click();
    await expect(titles(page)).toHaveCount(1);
    await expect(titles(page)).toContainText('Raw failing, server yes');
  });

  test('Needs Review lists the pull requests the server marks as needing one', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Needs Review' }).click();
    await expect(titles(page)).toHaveCount(1);
    await expect(titles(page)).toContainText('Server wants a review');
  });
});
