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
  for (const width of [1400, 390]) {
    test.describe(`${scheme}, ${width}px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
      });

      test('the message sits on the same side of the pill on an armed and an unarmed row', async ({
        page,
      }) => {
        await open(page, [PLAIN, ARMED_PR]);
        const plain = row(page, 'Plain');
        const armed = row(page, 'Armed');

        // Every element that says it, on both rows, on one side of the pill.
        const sides = async (r: Locator) => {
          const pill = await y(r.locator('.ci-pill'));
          const found = await waitingWords(r).all();
          expect(found.length).toBeGreaterThan(0);
          return Promise.all(
            found.map(async (e) => Math.sign((await y(e)) - pill)),
          );
        };
        const [plainSide] = await sides(plain);
        for (const side of [...(await sides(plain)), ...(await sides(armed))])
          expect(side).toBe(plainSide);
      });

      test('an armed row says it once and keeps a locked Merge with a reason', async ({
        page,
      }) => {
        await open(page, [PLAIN, ARMED_PR]);
        const armed = row(page, 'Armed');
        const merge = armed.getByRole('button', {
          name: 'Merge',
          exact: true,
        });

        await expect(waitingWords(armed)).toHaveCount(1);
        await expect(armed.locator('.wait-chip')).toBeVisible();
        await expect(armed.locator('.status-area')).toHaveCount(0);
        await expect(merge).toHaveAttribute('aria-disabled', 'true');
        await expect(merge).toHaveAccessibleDescription(/checks/i);

        // The unarmed row keeps its line and its next step.
        const plain = row(page, 'Plain');
        await expect(plain.locator('.status-area')).toContainText(
          'Waiting for CI to finish',
        );
        await expect(plain.locator('.status-area')).toContainText(
          'Merge unlocks automatically',
        );
      });

      test('the pop-up says it once too', async ({ page }) => {
        await open(page, [ARMED_PR]);
        const dialog = await openActionsDialog(row(page, 'Armed'));
        await expect(waitingWords(dialog)).toHaveCount(1);
      });

      test('a pill that says Passed leaves no waiting words on the row', async ({
        page,
      }) => {
        await open(page, [PLAIN, ARMED_PR], 'success');
        for (const title of ['Plain', 'Armed']) {
          const r = row(page, title);
          await expect(r.locator('.ci-pill')).toContainText('Passed');
          await expect(waitingWords(r)).toHaveCount(0);
          await expect(r.locator('.status-area')).toHaveCount(0);
          await expect(r.locator('.wait-chip')).toHaveCount(0);
        }
      });

      test('a locked Merge beside a Passed pill says where to look, not only that it is updating', async ({
        page,
      }) => {
        // The snapshot still waits on a check that the job list never shows
        // (#4433), so the lock can outlast one refresh.
        await open(page, [PLAIN], 'success');
        const r = row(page, 'Plain');
        await expect(r.locator('.ci-pill')).toContainText('Passed');
        const merge = r.getByRole('button', { name: 'Merge', exact: true });

        await expect(merge).toHaveAttribute('aria-disabled', 'true');
        await expect(merge).toHaveAccessibleDescription(
          /updating from the latest ci results/i,
        );
        await expect(merge).toHaveAccessibleDescription(
          /open the pull request on the forge/i,
        );
      });

      test('an armed row whose status is not a CI wait still drops the chip beside a Passed pill', async ({
        page,
      }) => {
        await open(page, [ARMED_DRAFT], 'success');
        const r = row(page, 'Armed draft');
        await expect(r.locator('.ci-pill')).toContainText('Passed');
        await expect(waitingWords(r)).toHaveCount(0);
        await expect(r.locator('.wait-chip')).toHaveCount(0);
        const merge = r.getByRole('button', { name: 'Merge', exact: true });
        await expect(merge).toHaveAttribute('aria-disabled', 'true');
        await expect(merge).toHaveAccessibleDescription(/draft pull request/i);
      });

      test('a stale armed row keeps Disarm on the row, and Merge keeps its reason', async ({
        page,
      }) => {
        await open(page, [ARMED_PR], 'success');
        const r = row(page, 'Armed');
        await expect(r.locator('.wait-chip')).toHaveCount(0);
        await expect(
          r.getByRole('button', { name: /disarm|cancel auto-merge/i }),
        ).toBeVisible();
        const merge = r.getByRole('button', { name: 'Merge', exact: true });
        await expect(merge).toHaveAttribute('aria-disabled', 'true');
        await expect(merge).toHaveAccessibleDescription(
          /updating from the latest ci results/i,
        );
      });

      test('a live Running pill keeps the wait and Merge says it is waiting on checks', async ({
        page,
      }) => {
        await open(page, [PLAIN, ARMED_PR], 'running');
        for (const title of ['Plain', 'Armed']) {
          const r = row(page, title);
          await expect(r.locator('.ci-pill')).toContainText(/running/i);
          await expect(waitingWords(r)).toHaveCount(1);
          const merge = r.getByRole('button', { name: 'Merge', exact: true });
          await expect(merge).toHaveAttribute('aria-disabled', 'true');
          await expect(merge).toHaveAccessibleDescription(
            /checks|waiting for ci/i,
          );
          await expect(merge).not.toHaveAccessibleDescription(
            /updating from the latest ci results/i,
          );
        }
      });

      test('a pull request still checking for conflicts is no CI wait, so Merge never says it is updating from CI', async ({
        page,
      }) => {
        await open(page, [CHECKING], 'success');
        const r = row(page, 'Checking');
        // The live jobs have to arrive first, or the not-stale check is empty.
        await expect(r.locator('.ci-pill')).toContainText('Passed');
        const merge = r.getByRole('button', { name: 'Merge', exact: true });
        await expect(merge).toHaveAttribute('aria-disabled', 'true');
        await expect(merge).toHaveAccessibleDescription(
          /checking for conflicts/i,
        );
        await expect(merge).not.toHaveAccessibleDescription(
          /updating from the latest ci results/i,
        );
      });

      test('a locked Merge looks different from an enabled one and has no axe violations', async ({
        page,
      }) => {
        await open(page, [PLAIN, ARMED_PR, READY]);
        const style = (b: Locator) =>
          b.evaluate((el) => {
            const s = getComputedStyle(el);
            return `${s.borderTopStyle}|${s.backgroundColor}|${s.color}`;
          });
        const locked = await style(
          row(page, 'Plain').getByRole('button', {
            name: 'Merge',
            exact: true,
          }),
        );
        const enabled = await style(
          row(page, 'Ready').getByRole('button', {
            name: 'Merge',
            exact: true,
          }),
        );
        expect(locked).not.toBe(enabled);
        // Forced colors drop background and text colour, so the border style
        // has to carry the difference.
        expect(locked.split('|')[0]).not.toBe(enabled.split('|')[0]);
        await axe(page);
      });
    });
  }
}

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 900 } });

  test('tapping the locked Merge on a stale row shows the reason without a hover', async ({
    page,
  }) => {
    await open(page, [PLAIN], 'success');
    const r = row(page, 'Plain');
    await expect(r.locator('.ci-pill')).toContainText('Passed');
    const merge = r.getByRole('button', { name: 'Merge', exact: true });
    await merge.tap({ force: true });
    await expect(
      r.getByText('Updating from the latest CI results'),
    ).toBeVisible();
    await expect(
      r.getByText(/open the pull request on the forge/i),
    ).toBeVisible();
  });
});
