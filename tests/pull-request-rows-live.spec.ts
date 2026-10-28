import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { pushChecks, serveChecks } from './checks-feed-helper';
import { closeStream } from './fake-stream-helper';
import { test } from './server-fixture';

// The Pull requests page follows the jobs of the first rows it draws, so a row
// reads the same list its pipeline dialog would, without the dialog open. Rows
// past the watch limit keep the refresh's pill. Which rows are watched, and
// how a list folds into a pill, are unit-tested (pr-row-watch.test.ts,
// pr-fold.test.ts); this proves the page wires them together.

const ROWS = 9;
const CAP = 8;

const FAILED = [
  {
    name: 'build',
    status: 'completed',
    conclusion: 'failure',
    url: 'https://example.com/r/1',
  },
];

const subjectOf = (number: number) => ({
  kind: 'pull_request' as const,
  forge: 'github',
  fullName: 'alrayyes/forge-dashboard',
  number,
});

async function serveBoard(page: Page, count: number) {
  await page.route('**/api/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: Array.from({ length: count }, (_, i) => pr(i + 1)),
        issues: [],
      }),
    }),
  );
}

function pr(number: number) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Change ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft: false,
    ci: 'pending',
    checks: { passed: 1, running: 1, waiting: 0, failed: 0 },
    labels: [],
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000 * number).toISOString(),
    mergeStatus: 'blocked',
    status: 'blocked',
    kind: 'regular',
    behind: false,
    allowedActions: [] as { action: string }[],
  };
}

const PASSED = [
  {
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.com/r/1',
  },
  {
    name: 'test',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.com/r/2',
  },
];

test.describe('pull request rows follow their jobs', () => {
  test('the first rows read their live jobs and the rest keep the refresh', async ({
    page,
  }) => {
    const feed = await serveChecks(page, () => PASSED);
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: Array.from({ length: ROWS }, (_, i) => pr(i + 1)),
          issues: [],
        }),
      }),
    );
    await page.goto('/pull-requests.html');

    const rows = page.locator('#pr-rows .row');
    await expect(rows).toHaveCount(ROWS);
    // Seven of the eight subjects: one stays free for the pipeline dialog.
    await expect(rows.nth(0)).toContainText('Passed');
    await expect(rows.nth(6)).toContainText('Passed');
    await feed.idle();
    expect(feed.asked).toHaveLength(7);
    await expect(rows.nth(7)).toContainText('Running');
    await expect(rows.nth(8)).toContainText('Running');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a dialog opened on a watched row lists its jobs without a new watch', async ({
    page,
  }) => {
    const feed = await serveChecks(page, () => PASSED);
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [pr(1)],
          issues: [],
        }),
      }),
    );
    await page.goto('/pull-requests.html');
    await expect(page.locator('#pr-rows .row').first()).toContainText('Passed');
    await feed.idle();

    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();

    await expect(page.locator('#pipeline-dialog .pipeline-check')).toHaveCount(
      2,
    );
    expect(feed.asked).toHaveLength(1);
  });

  test('a page change watches the new rows and lets go of the departed', async ({
    page,
  }) => {
    const feed = await serveChecks(page, () => PASSED);
    await serveBoard(page, 30);
    await page.goto('/pull-requests.html');
    const rows = page.locator('#pr-rows .row');
    await expect(rows.first()).toContainText('Passed');
    await feed.idle();
    expect(feed.asked).toHaveLength(7);

    await page.getByRole('button', { name: 'Next' }).first().click();
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText('Passed');
    await feed.idle();

    // Five new rows were listed, the seven that left were let go of first.
    expect(feed.asked).toHaveLength(12);
    expect(feed.posts.every((n) => n <= CAP)).toBe(true);
    expect(feed.posts.at(-1)).toBe(5);
  });

  test('a fold that lands while updates are paused draws when they resume', async ({
    page,
  }) => {
    const feed = await serveChecks(page, () => PASSED);
    await serveBoard(page, 1);
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    await expect(row).toContainText('Passed');
    await feed.idle();

    await page.locator('#pause-updates-button').click();
    await pushChecks(page, subjectOf(1), FAILED);
    await expect(row).toContainText('Passed');

    await page.locator('#pause-updates-button').click();
    await expect(row).toContainText('Failed');
  });

  test('the dialog and its row agree, and the row keeps it after close', async ({
    page,
  }) => {
    const feed = await serveChecks(page, () => PASSED);
    await serveBoard(page, 1);
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    await expect(row).toContainText('Passed');
    await feed.idle();

    await row.getByRole('button', { name: 'Open pipeline' }).click();
    await pushChecks(page, subjectOf(1), FAILED);
    await expect(page.locator('#pipeline-dialog .pipeline-check')).toHaveCount(
      1,
    );

    await page.keyboard.press('Escape');
    await expect(row).toContainText('Failed');
  });

  // A row that read its live jobs must not keep a pill the stream can no longer
  // vouch for. It reads the refresh again while the stream is down, and folds
  // live once the stream lists it again. The fallback is unit-tested
  // (row-watcher.test.ts); this proves the board redraws for it.
  test('a row reads the refresh while the stream is down and folds live again after', async ({
    page,
  }) => {
    await page.clock.install();
    const feed = await serveChecks(page, () => PASSED);
    await serveBoard(page, 1);
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    await expect(row).toContainText('Passed');
    await feed.idle();

    await closeStream(page);
    feed.forget();
    await expect(row).toContainText('Running');

    // The page opens the stream again and the watch goes out with it.
    await page.clock.runFor(3000);
    await expect(row).toContainText('Passed');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  // Forgejo leaves the jobs behind a failed one blocked in the finished run and
  // reports them pending. The run's own facts say it is over, so the row draws
  // a plain failure: no waiting segment and no spinner (#3035).
  test('queued jobs of a failed run do not make the row wait', async ({
    page,
  }) => {
    const run = {
      runId: 455,
      runAttempt: 1,
      runFacts: { status: 'completed', conclusion: 'failure' },
    };
    const blocked = (name: string) => ({
      name,
      status: 'queued',
      url: `https://example.com/r/${name}`,
      ...run,
    });
    await serveChecks(page, () => [
      { ...FAILED[0], ...run },
      blocked('deploy'),
      blocked('notify'),
    ]);
    await serveBoard(page, 1);
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();

    await expect(row).toContainText('Failed');
    await expect(row.locator('.ci-seg-waiting')).toHaveCount(0);
    await expect(row.locator('.check-glyph-arc')).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('queued jobs of a rerun still count as waiting', async ({ page }) => {
    const failed = { runId: 455, runAttempt: 1 };
    const rerun = {
      runId: 455,
      runAttempt: 2,
      runFacts: { status: 'in_progress' },
    };
    await serveChecks(page, () => [
      { ...FAILED[0], ...failed },
      {
        name: 'build',
        status: 'queued',
        url: 'https://example.com/r/1',
        ...rerun,
      },
    ]);
    await serveBoard(page, 1);
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();

    await expect(row.locator('.ci-seg-waiting')).toHaveCount(1);
  });
});
