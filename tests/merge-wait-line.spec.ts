import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A pull request that only waits (CI running, or Forgejo checking for
// conflicts) shows one line of text in Merge's slot, not a locked Merge and
// two lines of reason. The button takes the slot back when the forge allows
// the merge, announced only to a person who is on that row. Reasons a person
// can act on keep their locked Merge and printed words.
// https://github.com/alrayyes/forge-dashboard/issues/4528

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

const blocked = (code: string, message: string, next: string) => ({
  status: { code, message, next },
  allowedActions: [
    { action: 'merge', blocked: { code, message, next } },
    { action: 'close' },
  ],
});

const READY_ACTIONS = {
  status: undefined,
  allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
};

const waitingOnCi = (n: number, title: string) =>
  pr(n, title, {
    ...blocked(
      'checks_pending',
      'Waiting for CI to finish',
      'Merge unlocks automatically',
    ),
  });
const ready = (n: number, title: string) =>
  pr(n, title, { ci: 'success', mergeStatus: 'mergeable', ...READY_ACTIONS });
const checking = pr(5, 'Checking', {
  ci: 'success',
  mergeStatus: 'checking',
  ...blocked(
    'checks_pending',
    'Checking for conflicts',
    'Merge unlocks once the forge finishes',
  ),
});
const protectedBranch = pr(6, 'Protected', {
  ci: 'success',
  ...blocked(
    'blocked_by_protection',
    'A required review is missing',
    'Ask a reviewer to approve',
  ),
});
const notMergeable = pr(7, 'Refused', {
  ci: 'success',
  ...blocked(
    'not_mergeable',
    'The forge will not merge this',
    'Check the forge',
  ),
});

function snapshot(pullRequests: unknown[]) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [forgeHealth('github')],
    pullRequests,
    issues: [],
    openIssueCount: 0,
    repos: [],
    hiddenDrafts: 0,
  };
}

// The stream is kept so a test can push a second snapshot into the same page,
// as the server does.
async function open(page: Page, pullRequests: unknown[]) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(pullRequests)),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(
    pullRequests.length,
  );
}

async function push(page: Page, pullRequests: unknown[]) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify(snapshot(pullRequests)),
  );
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });
const mergeButton = (r: Locator) =>
  r.getByRole('button', { name: 'Merge', exact: true });

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test.describe(`${scheme}, ${width}px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
      });

      test('a row that only waits on CI shows one line and no locked Merge', async ({
        page,
      }) => {
        await open(page, [waitingOnCi(1, 'Waiting'), ready(2, 'Ready')]);
        const r = row(page, 'Waiting');

        await expect(r.getByText('Merge after CI')).toHaveCount(1);
        await expect(r.getByText('Merge after CI')).toBeVisible();
        await expect(mergeButton(r)).toHaveCount(0);
        await expect(r.locator('[aria-disabled="true"]')).toHaveCount(0);
        await expect(r.getByText('Merge unlocks automatically')).toHaveCount(0);
        await expect(r.getByText('Waiting for CI to finish')).toHaveCount(0);
        await expect(r.locator('.status-area')).toHaveCount(0);
        // Real text: no tooltip, no info icon to hover.
        await expect(r.locator('.row-action-locked-hint')).toHaveCount(0);

        const results = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .analyze();
        expect(results.violations).toEqual([]);
      });

      test('the line takes the slot Merge uses, so the row keeps its height', async ({
        page,
      }) => {
        await open(page, [waitingOnCi(1, 'Waiting'), ready(2, 'Ready')]);
        const slot = (title: string) =>
          row(page, title).evaluate((r) => {
            const el = r.querySelector('.merge-wait, button.row-action');
            const box = el?.getBoundingClientRect();
            return {
              row: r.getBoundingClientRect().height,
              slot: box ? Math.round(box.height) : 0,
            };
          });
        const waiting = await slot('Waiting');
        const merge = await slot('Ready');
        expect(waiting.slot).toBeGreaterThanOrEqual(merge.slot);
        expect(waiting.row).toBeLessThanOrEqual(merge.row + 1);
      });

      test('Forgejo checking for conflicts follows the same rule', async ({
        page,
      }) => {
        await open(page, [checking]);
        const r = row(page, 'Checking');
        await expect(r.getByText('Merge after check')).toBeVisible();
        await expect(mergeButton(r)).toHaveCount(0);
      });

      test('there is no dead stop on a locked control when tabbing', async ({
        page,
      }) => {
        await open(page, [waitingOnCi(1, 'Waiting')]);
        const stops = await row(page, 'Waiting')
          .locator('button, a, [tabindex]')
          .evaluateAll((els) =>
            els.map((e) => e.getAttribute('aria-disabled') ?? ''),
          );
        expect(stops).not.toContain('true');
      });

      test('reasons a person can act on keep the locked Merge and its printed reason', async ({
        page,
      }) => {
        await open(page, [protectedBranch, notMergeable]);
        for (const [title, reason] of [
          ['Protected', /required review is missing/i],
          ['Refused', /will not merge this/i],
        ] as const) {
          const r = row(page, title);
          await expect(mergeButton(r)).toHaveAttribute('aria-disabled', 'true');
          await expect(mergeButton(r)).toHaveAccessibleDescription(reason);
          await expect(r.getByText('Merge after CI')).toHaveCount(0);
        }
      });
    });
  }
}

test.describe('the unlock is announced only to the row the person is on', () => {
  const announced = (page: Page) =>
    page.locator('#list-updates-status').textContent();

  test('focus in the row hears Merge is available once it unlocks', async ({
    page,
  }) => {
    await open(page, [waitingOnCi(1, 'Mine'), waitingOnCi(2, 'Other')]);
    await row(page, 'Mine').locator('button.title').focus();

    await push(page, [ready(1, 'Mine'), waitingOnCi(2, 'Other')]);

    await expect(mergeButton(row(page, 'Mine'))).toBeVisible();
    await expect(page.locator('#list-updates-status')).toHaveText(
      'Merge is available.',
    );
  });

  test('a row that unlocks in the background announces nothing', async ({
    page,
  }) => {
    await open(page, [waitingOnCi(1, 'Mine'), waitingOnCi(2, 'Other')]);
    await row(page, 'Mine').locator('button.title').focus();

    await push(page, [waitingOnCi(1, 'Mine'), ready(2, 'Other')]);

    await expect(mergeButton(row(page, 'Other'))).toBeVisible();
    expect(await announced(page)).toBe('');
  });

  test('nobody focused on the board hears nothing', async ({ page }) => {
    await open(page, [waitingOnCi(1, 'Mine')]);
    await push(page, [ready(1, 'Mine')]);
    await expect(mergeButton(row(page, 'Mine'))).toBeVisible();
    expect(await announced(page)).toBe('');
  });
});
