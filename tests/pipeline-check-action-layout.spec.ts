import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { factsOf } from './check-facts';
import { checkLinkName } from './check-link-name-helper';
import { serveChecks } from './checks-feed-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const run = 'https://github.com/alrayyes/forge-dashboard/actions/runs/9';
const now = new Date().toISOString();

// One row for each way a row can offer the job: a finished job with output, a
// held job, a queued and a running one (no log yet on GitHub), a check from an
// external status (no job id) and a skipped one with nothing to open.
const ROWS = [
  { name: 'failed-job', ...factsOf('failure'), url: run, jobId: 1 },
  { name: 'passed-job', ...factsOf('success'), url: run, jobId: 2 },
  { name: 'running-job', ...factsOf('running'), url: run, jobId: 3 },
  { name: 'queued-job', ...factsOf('queued'), url: run, jobId: 4 },
  { name: 'external-check', ...factsOf('success'), url: `${run}/x` },
  { name: 'held-job', ...factsOf('awaiting_approval'), url: run },
  { name: 'skipped-job', ...factsOf('skipped'), url: run, jobId: 5 },
];

async function open(page: Page, holdLog?: Promise<void>) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [forgeHealth('github')],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/forge-dashboard',
            number: 42,
            title: 'Add structured logging',
            url: 'https://example.com/42',
            author: 'ryankes',
            draft: false,
            ci: 'failure',
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
  await page.route('**/api/v1/checks/log*', async (route: Route) => {
    await holdLog;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: 'ok', truncated: false }),
    });
  });
  await serveChecks(page, () => ROWS);
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });
  await expect(dialog.locator('.pipeline-check')).toHaveCount(ROWS.length);
  return dialog;
}

// The control that opens the job, for a row, whichever way the row offers it.
function openControl(row: ReturnType<Page['locator']>) {
  return row.locator('.run-actions a.run-icon-btn');
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [360, 390, 1280]) {
    test(`every status offers the open-job action in one place with one control at ${width}px (${scheme}) (#3878)`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      const dialog = await open(page);
      const names = [
        ['failed-job', 'Open job on GitHub'],
        ['passed-job', 'Open job on GitHub'],
        ['running-job', 'Watch on GitHub'],
        ['queued-job', 'Open on GitHub'],
        ['external-check', 'Open check page'],
        ['held-job', 'Approve on GitHub'],
      ];
      const rights = new Set<number>();
      const sizes = new Set<string>();
      for (const [name, words] of names) {
        const row = dialog.locator('.pipeline-check', { hasText: name });
        const control = openControl(row);
        await expect(control).toHaveCount(1);
        await expect(control).toHaveAccessibleName(checkLinkName(words, name));
        const box = await control.boundingBox();
        const rowBox = await row.boundingBox();
        expect(box).not.toBeNull();
        if (!box || !rowBox) continue;
        if (width < 761) {
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
        }
        // The guaranteed contract: same control, size and right edge for every
        // status. A row with output puts it on the line of its Show output
        // toggle, so it may sit on a second line below the name.
        rights.add(Math.round(rowBox.x + rowBox.width - (box.x + box.width)));
        sizes.add(`${Math.round(box.width)}x${Math.round(box.height)}`);
      }
      expect([...rights]).toHaveLength(1);
      expect([...sizes]).toHaveLength(1);

      // A row with nothing to open keeps its reason and has no control.
      const skipped = dialog.locator('.pipeline-check', {
        hasText: 'skipped-job',
      });
      await expect(openControl(skipped)).toHaveCount(0);

      const results = await new AxeBuilder({ page })
        .include('dialog')
        .withTags(TAGS)
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('Show output does not move the open-job link (#3878)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const dialog = await open(page);
  const link = openControl(
    dialog.locator('.pipeline-check', { hasText: 'passed-job' }),
  );
  const before = await link.boundingBox();
  await dialog.getByRole('button', { name: 'Show output: passed-job' }).click();
  await expect(
    dialog.getByRole('region', { name: 'Output: passed-job' }),
  ).toBeVisible();
  expect(await link.boundingBox()).toEqual(before);
});

test('the action line does not move while output loads (#3878)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dialog = await open(page, held);
  const row = dialog.locator('.pipeline-check', { hasText: 'passed-job' });
  await dialog.getByRole('button', { name: 'Show output: passed-job' }).click();
  const control = openControl(row);
  const name = row.locator('.pipeline-check-name');
  const loading = [await control.boundingBox(), await name.boundingBox()];
  release();
  await expect(
    dialog.getByRole('button', { name: 'Copy output: passed-job' }),
  ).toBeVisible();
  // The output text below it changes the row's height, as it should; what
  // this ticket pins is that the top line and its action stay put.
  expect([await control.boundingBox(), await name.boundingBox()]).toEqual(
    loading,
  );
});
