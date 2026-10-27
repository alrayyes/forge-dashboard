import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { factsOf } from './check-facts';
import { type CheckRow, serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

// A Forgejo default branch's pill and its pipeline dialog describe one set of
// jobs: the server counts the pill from the same list it serves the dialog.
// The commit below is a recorded one (14 jobs: 4 passed, 10 skipped), where
// the pill once read one job as still running that the dialog showed passed.

const JOBS = [
  ['release', 'success'],
  ['artefacts', 'skipped'],
  ['secrets', 'success'],
  ['changes', 'success'],
  ['lint', 'skipped'],
  ['test', 'skipped'],
  ['build', 'skipped'],
  ['gomod', 'skipped'],
  ['gomod-tidy', 'skipped'],
  ['dockerfile', 'skipped'],
  ['docker-build', 'skipped'],
  ['prose', 'success'],
  ['advisories', 'skipped'],
  ['commits', 'skipped'],
].map(([name, state], i) => ({
  name,
  ...factsOf(state),
  jobId: 84350 - i,
  url: '',
}));

const ROW = {
  forge: 'forgejo',
  fullName: 'scaffolding/scaffold-go-cli',
  url: 'https://example.com/scaffolding/scaffold-go-cli',
  branch: 'main',
  status: 'passed',
  commit: {
    sha: '42381c9',
    subject: 'Merge pull request: update golang digest',
    author: 'renovatebot',
    committedAt: new Date(Date.now() - 1800_000).toISOString(),
  },
  failingJobs: [],
  finishedAt: null,
  durationSeconds: null,
  runUrl: 'https://example.com/scaffolding/scaffold-go-cli/actions/runs/582',
  checks: { passed: 14, skipped: 10, running: 0, waiting: 0, failed: 0 },
  staleSince: null,
};

async function open(
  page: Page,
  row: Omit<typeof ROW, 'checks'> & {
    checks: Partial<typeof ROW.checks>;
  } = ROW,
  jobs: unknown[] = JOBS,
) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 0,
          passed: 1,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: 1,
        },
        branches: [row],
      }),
    }),
  );
  await serveChecks(page, () => jobs as CheckRow[]);
  await page.goto('/');
  const pill = page.getByRole('button', { name: /open pipeline/i }).first();
  await expect(pill).toBeVisible();
  await pill.click();
}

const panel = (page: Page) => page.getByRole('dialog', { name: /pipeline/i });

test.describe('the Branches pill and its dialog agree', () => {
  test('the pill counts the jobs the dialog lists', async ({ page }) => {
    await open(page);
    const items = panel(page).getByRole('listitem');
    await expect(items).toHaveCount(JOBS.length);

    const pill = page.getByRole('button', { name: /open pipeline/i }).first();
    const label = (await pill.getAttribute('aria-label')) ?? '';
    expect(label).not.toMatch(/running|waiting/i);
    await expect(panel(page).getByText(/running/i)).toHaveCount(0);
    await expect(items.filter({ hasText: 'Skipped' })).toHaveCount(10);
    await expect(items.filter({ hasText: 'Passed' })).toHaveCount(4);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await expect(panel(page).getByRole('listitem')).toHaveCount(JOBS.length);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

// A manual rerun of a failed run keeps the run and its job ids, and the jobs
// start again on the next attempt. The row was read mid-rerun (the Go replay
// of that, a modelled sequence, is internal/forgejo/main_branch_rerun_sequence_test.go), so its
// pill and the dialog show the new attempt's jobs, and not the failed one's.
test.describe('the Branches pill and its dialog agree during a rerun', () => {
  const rerunRow = {
    ...ROW,
    status: 'running',
    runUrl: 'https://example.com/scaffolding/scaffold-go-cli/actions/runs/401',
    checks: { passed: 1, running: 1, waiting: 1, failed: 0 },
  };
  const rerunJobs = [
    {
      name: 'lint',
      status: 'completed',
      conclusion: 'success',
      jobId: 90010,
      runAttempt: 1,
      url: '',
    },
    {
      name: 'build',
      status: 'in_progress',
      jobId: 90001,
      runAttempt: 2,
      url: '',
    },
    { name: 'deploy', status: 'queued', jobId: 90002, runAttempt: 2, url: '' },
  ];

  test('the pill and the dialog show the same running and queued jobs, with no axe violations', async ({
    page,
  }) => {
    await open(page, rerunRow, rerunJobs);
    const items = panel(page).getByRole('listitem');
    await expect(items).toHaveCount(3);
    await expect(items.filter({ hasText: 'Running' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'Queued' })).toHaveCount(1);
    await expect(panel(page).getByText(/failed/i)).toHaveCount(0);

    const pill = page.getByRole('button', { name: /open pipeline/i }).first();
    const label = (await pill.getAttribute('aria-label')) ?? '';
    expect(label).toContain('1 passed, 1 running, 1 waiting');
    expect(label).not.toMatch(/failed/i);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
