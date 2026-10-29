import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// A Forgejo row carries the runs of its newest commit, and the page folds them
// into the pill, the counts and the Failing: line. A row with no runs reads the
// refresh's own answer. The folds themselves are unit tested
// (web/src/lib/main-branch-snapshot-runs.test.ts); this proves the wiring.

const job = (name: string, status: string, conclusion?: string) => ({
  name,
  url: `https://example.com/${name}`,
  status,
  ...(conclusion ? { conclusion } : {}),
});

function row(
  fullName: string,
  status: string,
  checks: Record<string, number>,
  failingJobs: string[],
  runs?: unknown[],
) {
  return {
    forge: 'forgejo',
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status,
    commit: {
      sha: 'd98f3c2',
      subject: `fix: change in ${fullName}`,
      author: 'sre-dev',
      committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    failingJobs,
    finishedAt: null,
    durationSeconds: null,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    checks,
    ...(runs ? { runs } : {}),
    staleSince: null,
  };
}

// Both rows say failed in the refresh. The first has runs that say a rerun is
// going and one job passed; the second has no runs to say otherwise.
const BRANCHES = [
  row(
    'acme/rerun',
    'failed',
    { passed: 2, running: 0, waiting: 0, failed: 1 },
    ['secrets'],
    [
      {
        runId: 7,
        runAttempt: 2,
        status: 'in_progress',
        checks: [
          job('lint', 'completed', 'success'),
          job('secrets', 'in_progress'),
        ],
      },
    ],
  ),
  row(
    'acme/plain',
    'failed',
    { passed: 2, running: 0, waiting: 0, failed: 1 },
    ['lint'],
  ),
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 2,
          passed: 0,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: BRANCHES.length,
        },
        branches: BRANCHES,
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
    BRANCHES.length,
  );
}

const rowOf = (page: Page, repo: string) =>
  page.locator('[data-testid="main-branch-row"]', { hasText: repo });

test.describe('Main branches rows fold the snapshot runs', () => {
  test('a row follows its runs, and one with none keeps the refresh', async ({
    page,
  }) => {
    await open(page);

    await expect(rowOf(page, 'acme/rerun').locator('.ci-pill')).toContainText(
      'Running',
    );
    await expect(rowOf(page, 'acme/rerun')).not.toContainText('Failing:');
    await expect(rowOf(page, 'acme/plain').locator('.ci-pill')).toContainText(
      'Failed',
    );
    await expect(rowOf(page, 'acme/plain')).toContainText('lint');
  });

  test('the page has no axe violations', async ({ page }) => {
    await open(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
