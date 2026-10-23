import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
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
].map(([name, state], i) => ({ name, state, jobId: 84350 - i, url: '' }));

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
  stale: false,
  staleSince: null,
};

async function open(page: Page) {
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
        branches: [ROW],
      }),
    }),
  );
  await page.route('**/api/main-branches/checks*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ checks: JOBS }),
    }),
  );
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
