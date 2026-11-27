import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { openActionsDialog } from './actions-dialog-helper';
import { factsOf } from './check-facts';
import { serveChecks } from './checks-feed-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The wait for CI is said once on a row, in the same place whether or not
// auto-merge is armed, and only while the CI pill says the checks are still
// running. The status line, the locked Merge and the armed chip all read the
// snapshot while the pill can read the live jobs, so a row could say both
// "Passed" and "Waiting for CI".
// https://github.com/alrayyes/forge-dashboard/issues/4408
//
// Merge's slot carries the wait as one line of text, not a locked button
// (#4528); an armed row's chip is that one place.
//
// The edges (#4435): the armed chip follows the pill whatever the status says,
// a stale armed row keeps a way to disarm, and every case says why Merge is
// locked: live Running keeps the wait, `checking` is no wait on CI.

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function pr(number: number, title: string, over: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.test/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'pending',
    checks: { passed: 1, running: 1, waiting: 0, failed: 0 },
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    ...over,
  };
}

const ARMED = {
  autoMergeEnabled: true,
  autoMerge: {
    state: 'waiting',
    code: 'checks_pending',
    message: 'Auto-merge is waiting for the checks to pass.',
  },
};

const PLAIN = pr(1, 'Plain');
const ARMED_PR = pr(2, 'Armed', ARMED);
// The armed chip's code says CI, but the status is another wait.
const ARMED_DRAFT = pr(4, 'Armed draft', {
  ...ARMED,
  draft: true,
});
const CHECKING = pr(5, 'Checking', { mergeStatus: 'checking' });
const BLOCKED = pr(8, 'Blocked', { ci: 'success' });
const READY = pr(3, 'Ready', { ci: 'success', mergeStatus: 'mergeable' });

async function open(
  page: Page,
  pullRequests: unknown[],
  jobState?: string,
): Promise<void> {
  if (jobState) {
    await serveChecks(page, () =>
      [0, 1].map((i) => ({
        name: `job-${i}`,
        ...factsOf(jobState),
        jobId: 100 + i,
        url: '',
      })),
    );
  } else {
    await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
  }
  await page.route('**/api/v1/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(
    pullRequests.length,
  );
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

// Every element on the row that says it is waiting for CI.
const waitingWords = (scope: Locator) => scope.getByText(/waiting for ci/i);

async function y(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('not on screen');
  return box.y;
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(results.violations).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1400, 1000, 390]) {
    test.describe(`${scheme}, ${width}px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
      });

      test('an unarmed and an armed row both say it once, in the same chip', async ({
        page,
      }) => {
        await open(page, [PLAIN, ARMED_PR]);
        const plain = row(page, 'Plain');
        const armed = row(page, 'Armed');
        const merge = (r: Locator) =>
          r.getByRole('button', { name: 'Merge', exact: true });

        await expect(plain.getByText('Waiting for CI')).toHaveCount(1);
        await expect(plain.locator('.wait-chip')).toHaveCount(1);
        await expect(plain.locator('.status-area')).toHaveCount(0);
        await expect(merge(plain)).toHaveCount(0);

        await expect(waitingWords(armed)).toHaveCount(1);
        await expect(armed.locator('.wait-chip')).toBeVisible();
        await expect(armed.locator('.status-area')).toHaveCount(0);
        await expect(merge(armed)).toHaveCount(0);
      });

      test('the pop-up says it once too', async ({ page }) => {
        await open(page, [ARMED_PR]);
        const dialog = await openActionsDialog(row(page, 'Armed'));
        // The pop-up has no chip, so the wait is Merge's one line there.
        await expect(dialog.getByText(/after ci|waiting for ci/i)).toHaveCount(
          1,
        );
      });

      test('a pill that says Passed leaves no CI wait on the row, only the forge refresh chip', async ({
        page,
      }) => {
        await open(page, [PLAIN, ARMED_PR], 'success');
        for (const title of ['Plain', 'Armed']) {
          const r = row(page, title);
          await expect(r.locator('.ci-pill')).toContainText('Passed');
          await expect(waitingWords(r)).toHaveCount(0);
          await expect(r.locator('.status-area')).toHaveCount(0);
          await expect(r.locator('.wait-chip .wait-chip-label')).toHaveText(
            title === 'Armed' ? 'Auto-merge on' : 'Waiting for the forge',
          );
        }
      });

      test('the chip beside a Passed pill says where to look, not only that it is updating', async ({
        page,
      }) => {
        // The snapshot still waits on a check that the job list never shows
        // (#4433), so the lock can outlast one refresh.
        await open(page, [PLAIN], 'success');
        const r = row(page, 'Plain');
        await expect(r.locator('.ci-pill')).toContainText('Passed');
        const chip = r.locator('.wait-chip');

        await expect(chip).toHaveAccessibleDescription(
          /updating from the latest ci results/i,
        );
        await expect(chip).toHaveAccessibleDescription(
          /open the pull request on the forge/i,
        );
      });

      test('the chip names the check the server says the forge waits on', async ({
        page,
      }) => {
        // The server names the check no job shows (#4442).
        await open(
          page,
          [pr(6, 'Named', { pendingChecks: ['deploy/gate', 'external/scan'] })],
          'success',
        );
        const r = row(page, 'Named');
        await expect(r.locator('.ci-pill')).toContainText('Passed');

        await expect(r.locator('.wait-chip')).toHaveAccessibleDescription(
          /waiting on deploy\/gate and external\/scan/i,
        );
        await axe(page);
      });

      test('the pop-up names the check in its locked Merge line', async ({
        page,
      }) => {
        await open(
          page,
          [pr(6, 'Named', { pendingChecks: ['deploy/gate', 'external/scan'] })],
          'success',
        );
        const dialog = await openActionsDialog(row(page, 'Named'));

        await expect(
          dialog.getByText(
            "The forge is waiting on deploy/gate and external/scan, which the pipeline doesn't list.",
          ),
        ).toHaveCount(1);
      });

      test('a long check name with markup stays text, wraps inside the row and stays readable in full', async ({
        page,
      }) => {
        const name = `<img src=x onerror="window.__pwned=1">/${'very-long-check-name-'.repeat(8)}end`;
        await open(
          page,
          [pr(6, 'Named', { pendingChecks: [name] })],
          'success',
        );
        const r = row(page, 'Named');

        // The chip's description carries the whole name, as text.
        await expect(r.locator('.wait-chip')).toHaveAccessibleDescription(
          new RegExp(
            `waiting on ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
            'i',
          ),
        );
        await expect(r.locator('img[src="x"]')).toHaveCount(0);
        expect(
          await page.evaluate(() => (window as any).__pwned),
        ).toBeUndefined();
        // The row doesn't grow a horizontal scrollbar.
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        ).toBe(true);
        await axe(page);
      });

      test('an armed row whose status is not a CI wait shows the refresh chip beside a Passed pill', async ({
        page,
      }) => {
        await open(page, [ARMED_DRAFT], 'success');
        const r = row(page, 'Armed draft');
        await expect(r.locator('.ci-pill')).toContainText('Passed');
        await expect(waitingWords(r)).toHaveCount(0);
        await expect(r.locator('.wait-chip .wait-chip-label')).toHaveText(
          'Auto-merge on',
        );
      });

      test('a stale armed row keeps Cancel auto-merge beside the chip, which says why', async ({
        page,
      }) => {
        await open(page, [ARMED_PR], 'success');
        const r = row(page, 'Armed');
        const chip = r.locator('.wait-chip');
        await expect(chip).toHaveCount(1);
        await expect(
          r
            .locator('.row-action-bar')
            .getByRole('button', { name: 'Cancel auto-merge' }),
        ).toBeVisible();
        await expect(chip).toHaveAccessibleDescription(
          /updating from the latest ci results/i,
        );
      });

      test('a live Running pill keeps the wait, in one place and with no locked Merge', async ({
        page,
      }) => {
        await open(page, [PLAIN, ARMED_PR], 'running');
        for (const title of ['Plain', 'Armed']) {
          const r = row(page, title);
          await expect(r.locator('.ci-pill')).toContainText(/running/i);
          await expect(
            r.getByRole('button', { name: 'Merge', exact: true }),
          ).toHaveCount(0);
        }
        await expect(
          row(page, 'Plain').getByText('Waiting for CI'),
        ).toHaveCount(1);
        await expect(waitingWords(row(page, 'Armed'))).toHaveCount(1);
      });

      test('a pull request still checking for conflicts is no CI wait: it says so in one line and never claims to update from CI', async ({
        page,
      }) => {
        await open(page, [CHECKING], 'success');
        const r = row(page, 'Checking');
        // The live jobs have to arrive first, or the not-stale check is empty.
        await expect(r.locator('.ci-pill')).toContainText('Passed');
        await expect(r.getByText('Checking for conflicts')).toBeVisible();
        await expect(
          r.getByRole('button', { name: 'Merge', exact: true }),
        ).toHaveCount(0);
        await expect(r.getByText(/updating from the latest ci/i)).toHaveCount(
          0,
        );
      });

      test('a locked Merge looks different from an enabled one and has no axe violations', async ({
        page,
      }) => {
        await open(page, [BLOCKED, READY]);
        const style = (b: Locator) =>
          b.evaluate((el) => {
            const s = getComputedStyle(el);
            return `${s.borderTopStyle}|${s.backgroundColor}|${s.color}`;
          });
        const lockedMerge = row(page, 'Blocked').getByRole('button', {
          name: 'Merge',
          exact: true,
        });
        const enabledMerge = row(page, 'Ready').getByRole('button', {
          name: 'Merge',
          exact: true,
        });
        // Two buttons that have not painted yet read the same, so read both
        // again until they differ. Forced colors drop background and text
        // colour, so the border style has to carry the difference.
        await expect
          .poll(async () => {
            const locked = await style(lockedMerge);
            const enabled = await style(enabledMerge);
            return {
              differ: locked !== enabled,
              borderDiffers: locked.split('|')[0] !== enabled.split('|')[0],
            };
          })
          .toEqual({ differ: true, borderDiffers: true });
        await axe(page);
      });
    });
  }
}

// The stale-CI rule hides the armed chip only for a snapshot that read CI as
// pending (#4482). The other waits are not about CI, and a run that already
// ended is what the chip names, so a Passed pill never hides them.
test.describe('the stale-CI rule hides only a pending CI wait', () => {
  const armedWith = (title: string, code: string, over = {}) =>
    pr(10, title, {
      autoMergeEnabled: true,
      autoMerge: { state: 'waiting', code, message: `Held: ${code}.` },
      ...over,
    });

  for (const [code, label] of [
    ['stacked', 'Waiting for parent'],
    ['behind', 'Waiting for update'],
  ] as const) {
    test(`a ${code} wait keeps its chip beside a Passed pill, with no stale Cancel auto-merge in its place`, async ({
      page,
    }) => {
      await open(page, [armedWith('Armed', code)], 'success');
      const r = row(page, 'Armed');
      await expect(r.locator('.ci-pill')).toContainText('Passed');

      const chip = r.locator('.wait-chip');
      await expect(chip.locator('.wait-chip-label')).toHaveText(
        'Auto-merge on',
      );
      await expect(chip).toContainText(label);
      // The action column carries the one Cancel auto-merge; a stale rule would add another.
      const disarm = r.getByRole('button', {
        name: /disarm|cancel auto-merge/i,
      });
      await expect(disarm).toHaveCount(1);
      await expect(
        chip.getByRole('button', { name: /disarm|cancel auto-merge/i }),
      ).toHaveCount(0);
    });
  }

  test('a CI wait whose snapshot already ended keeps its chip beside a Passed pill', async ({
    page,
  }) => {
    await open(
      page,
      [armedWith('Ended', 'checks_pending', { ci: 'failure' })],
      'success',
    );
    const r = row(page, 'Ended');
    await expect(r.locator('.ci-pill')).toContainText('Passed');
    const chip = r.locator('.wait-chip');
    await expect(chip.locator('.wait-chip-label')).toHaveText('Auto-merge on');
    await expect(chip).toContainText('Waiting for CI');
  });
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 900 } });

  test('focusing the chip on a stale row shows the reason without a hover', async ({
    page,
  }) => {
    await open(page, [PLAIN], 'success');
    const r = row(page, 'Plain');
    await expect(r.locator('.ci-pill')).toContainText('Passed');
    await r.locator('.wait-chip').focus();
    await expect(
      r.getByText('Updating from the latest CI results'),
    ).toBeVisible();
    await expect(
      r.getByText(/open the pull request on the forge/i),
    ).toBeVisible();
  });
});
