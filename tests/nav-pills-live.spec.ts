import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { pushChecks, serveChecks } from './checks-feed-helper';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// A row that reads its live jobs says what CI is doing before the next
// snapshot does, so the menu pill counts it the same way (#5123). Which number
// a pull request lands in, drafts and bots included, is unit-tested
// (nav-counts-live.test.ts); this proves the page hands the pills what it
// reads.

const REPO = 'alrayyes/forge-dashboard';

const run = (status: string, conclusion?: string) => [
  { name: 'build', status, conclusion, url: 'https://example.com/r/1' },
];
const RUNNING = run('in_progress');
const FAILED = run('completed', 'failure');
const PASSED = run('completed', 'success');

const subjectOf = (number: number) => ({
  kind: 'pull_request' as const,
  forge: 'github',
  fullName: REPO,
  number,
});

function pr(number: number, over: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: REPO,
    number,
    title: `Change ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    checks: { passed: 1, running: 0, waiting: 0, failed: 0 },
    labels: [],
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000 * number).toISOString(),
    mergeStatus: 'blocked',
    status: 'blocked',
    kind: 'regular',
    behind: false,
    allowedActions: [] as { action: string }[],
    ...over,
  };
}

// The snapshot never changes here, so anything that moves a number is the live
// list.
async function serve(page: Page, state: { pullRequests: unknown[] }) {
  await page.route('**/api/v1/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: state.pullRequests,
        issues: [],
        navCounts: navCountsFor(state.pullRequests, 0),
      }),
    }),
  );
}

const link = (page: Page, path: string) =>
  page.locator(`.app-nav a[href="${path}"]`);

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('menu pills follow live CI (#5123)', () => {
  test('a watched row moves the pill before any snapshot, and back', async ({
    page,
  }) => {
    const feed = await serveChecks(page, () => PASSED);
    await serve(page, { pullRequests: [pr(1), pr(2)] });
    await page.goto('/pull-requests.html');
    const pulls = link(page, '/pull-requests.html');
    await expect(pulls).toHaveAccessibleName('2, Pull requests, 2 passing');
    await feed.idle();

    await pushChecks(page, subjectOf(1), RUNNING);

    await expect(pulls).toHaveAccessibleName(
      '2 1 1, Pull requests, 2 total, 1 passing, 1 running',
    );
    await expect(pulls.locator('.nav-total')).toHaveText('2');
    await expect(pulls.locator('.nav-running')).toHaveText('1');
    await expectNoViolations(page);

    await pushChecks(page, subjectOf(1), PASSED);
    await expect(pulls).toHaveAccessibleName('2, Pull requests, 2 passing');
  });

  // The releases and bots pages watch no rows: the dialog is their live list.
  test('the open dialog moves the pill', async ({ page }) => {
    await serveChecks(page, () => FAILED);
    await serve(page, { pullRequests: [pr(1, { kind: 'release' })] });
    await page.goto('/releases.html');
    const releases = link(page, '/releases.html');
    await expect(releases).toHaveAccessibleName('1, Releases, 1 passing');

    await page.locator('#pr-rows .row [id^="pipeline-trigger-"]').click();
    await expect(releases.locator('.nav-failed')).toHaveText('1');
    await expect(releases.locator('.nav-passed')).toHaveCount(0);

    // Closed, the row reads the snapshot again, and so does the pill.
    await page.keyboard.press('Escape');
    await expect(releases).toHaveAccessibleName('1, Releases, 1 passing');
  });

  test('leaving the page drops the live reading', async ({ page }) => {
    const feed = await serveChecks(page, () => RUNNING);
    await serve(page, { pullRequests: [pr(1)] });
    await page.goto('/pull-requests.html');
    const pulls = link(page, '/pull-requests.html');
    await expect(pulls).toHaveAccessibleName('1, Pull requests, 1 running');
    await feed.idle();

    await page.locator('.app-nav a[href="/insights.html"]').click();

    await expect(pulls).toHaveAccessibleName('1, Pull requests, 1 passing');
  });
});
