import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { serveChecks } from './checks-feed-helper';
import { test } from './server-fixture';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// A Forgejo job nothing has started is either waiting on the jobs it needs or
// waiting for a runner, and the server says which (waitingFor). A blocked job
// in a failed run gets no reason and a GitHub queued job never has one; both
// keep the plain wording (#3634).
const url = 'https://forge.example/example/app/actions/runs/1/jobs/1';

async function open(page: Page, forge: 'forgejo' | 'github') {
  const now = new Date().toISOString();
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [{ forge, reachable: true, repoCount: 1 }],
        pullRequests: [
          {
            forge,
            repo: 'example/app',
            number: 7,
            title: 'Add structured logging',
            url: 'https://example.com/7',
            author: 'someone',
            draft: false,
            ci: 'pending',
            labels: [],
            createdAt: now,
            updatedAt: now,
            mergeStatus: 'mergeable',
            behind: false,
          },
        ],
        issues: [],
      }),
    }),
  );
  await serveChecks(page, () => [
    {
      name: 'blocked-job',
      status: 'queued',
      waitingFor: 'jobs',
      url,
      jobId: 1,
    },
    {
      name: 'waiting-job',
      status: 'queued',
      waitingFor: 'runner',
      url,
      jobId: 2,
    },
    { name: 'plain-job', status: 'queued', url, jobId: 3 },
    {
      name: 'skipped-job',
      status: 'completed',
      conclusion: 'skipped',
      url,
      jobId: 4,
    },
  ]);
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
  await expect(dialog.locator('.pipeline-check')).toHaveCount(4);
  return dialog;
}

const hint = (dialog: ReturnType<Page['locator']>, name: string) =>
  dialog
    .locator('.pipeline-check', { hasText: name })
    .locator('.pipeline-check-hint');

test.describe('queued Forgejo jobs say what they wait for (#3634)', () => {
  test('blocked reads as waiting on earlier jobs, waiting as queued for a runner', async ({
    page,
  }) => {
    const dialog = await open(page, 'forgejo');
    await expect(hint(dialog, 'blocked-job')).toHaveText(
      'Waiting on earlier jobs.',
    );
    await expect(hint(dialog, 'waiting-job')).toHaveText(
      'Queued for a runner.',
    );
    // No reason sent (a blocked job in a failed run): today's wording.
    await expect(hint(dialog, 'plain-job')).toHaveText('Not started yet.');
    // A job that settled as skipped still reads Skipped, with no hint.
    await expect(
      dialog
        .locator('.pipeline-check', { hasText: 'skipped-job' })
        .locator('.pipeline-check-status.skipped'),
    ).toContainText('Skipped');
    await expect(hint(dialog, 'skipped-job')).toHaveCount(0);

    expect(
      (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations,
    ).toEqual([]);
  });

  test('a GitHub queued check keeps its wording', async ({ page }) => {
    const dialog = await open(page, 'github');
    await expect(hint(dialog, 'plain-job')).toHaveText('Not started yet.');
  });
});
