import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A pull request that only waits (CI running, or Forgejo checking for
// conflicts) shows the same one-line chip an armed auto-merge does: "Waiting
// for CI" with an Auto-merge button that arms it, or Cancel auto-merge once it
// is armed. The extra words are the chip's tooltip, on hover and on keyboard
// focus, and its accessible description. No locked Merge, no dashed
// placeholder, and no row taller than a normal one. The Merge button takes
// the slot back when the forge allows the merge, announced only to a person
// who is on that row. Reasons a person can act on keep their locked Merge and
// printed words.
// https://github.com/alrayyes/forge-dashboard/issues/4528
// https://github.com/alrayyes/forge-dashboard/issues/4663

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

const blocked = (code: string, message: string, next?: string) => ({
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

const CI_BLOCK = {
  code: 'checks_pending',
  message: 'Waiting for CI to finish',
};
// The same wait, where the server offers auto-merge (it does while CI runs).
const offered = (n: number, title: string, extra: unknown[] = []) =>
  pr(n, title, {
    status: CI_BLOCK,
    allowedActions: [
      { action: 'merge', blocked: CI_BLOCK },
      { action: 'auto_merge' },
      ...extra,
      { action: 'close' },
    ],
  });
const armedWait = (n: number, title: string) =>
  pr(n, title, {
    status: CI_BLOCK,
    autoMergeEnabled: true,
    autoMerge: {
      state: 'waiting',
      code: 'checks_pending',
      message: 'Auto-merge is waiting for checks to finish.',
    },
    allowedActions: [
      { action: 'merge', blocked: CI_BLOCK },
      { action: 'cancel_auto_merge' },
      { action: 'close' },
    ],
  });
const ready = (n: number, title: string) =>
  pr(n, title, { ci: 'success', mergeStatus: 'mergeable', ...READY_ACTIONS });
const CHECK_BLOCK = {
  code: 'checks_pending',
  message: 'Checking for conflicts',
};
const checking = pr(5, 'Checking', {
  ci: 'success',
  mergeStatus: 'checking',
  status: CHECK_BLOCK,
  allowedActions: [
    { action: 'merge', blocked: CHECK_BLOCK },
    { action: 'auto_merge' },
    { action: 'close' },
  ],
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

const UNKNOWN_BLOCK = {
  code: 'status_unknown',
  message: 'Merge status not known yet',
};
// The forge hasn't reported whether it merges (#4666). The server offers
// auto-merge in this state.
const unknownStatus = (n: number, title: string) =>
  pr(n, title, {
    ci: 'success',
    mergeStatus: 'unknown',
    status: UNKNOWN_BLOCK,
    allowedActions: [
      { action: 'merge', blocked: UNKNOWN_BLOCK },
      { action: 'auto_merge' },
      { action: 'close' },
    ],
  });
const draftBlock = pr(8, 'Draft', {
  ci: 'success',
  draft: true,
  ...blocked('not_mergeable', 'Draft pull request'),
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
async function open(
  page: Page,
  pullRequests: unknown[],
  path = '/pull-requests.html',
) {
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
  // One read, stamped when the page opens: a poll answered later must not look
  // newer than a push, or the page drops the push as stale (#5062).
  const read = JSON.stringify(snapshot(pullRequests));
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: read,
    }),
  );
  await page.goto(path);
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

// Finds and measures in one step. A locator finds the row first and measures
// it in a second call, and a redraw between the two leaves a detached element,
// which is 0px tall (#5062).
const heightOf = (page: Page, title: string) =>
  page.evaluate((wanted) => {
    const found = [...document.querySelectorAll('#pr-rows > .row')].find((r) =>
      r.querySelector('.title-cell > .title')?.textContent?.includes(wanted),
    );
    if (!found) throw new Error(`no row titled ${wanted}`);
    return found.getBoundingClientRect().height;
  }, title);

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(results.violations).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 1024, 390]) {
    test.describe(`${scheme}, ${width}px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
      });

      test('a row that only waits on CI is one chip with an Auto-merge button and no locked Merge', async ({
        page,
      }) => {
        await open(page, [offered(1, 'Waiting'), ready(2, 'Ready')]);
        const r = row(page, 'Waiting');
        const chip = r.locator('.wait-chip');

        await expect(chip).toHaveCount(1);
        await expect(chip.locator('.wait-chip-label')).toHaveText(
          'Waiting for CI',
        );
        await expect(
          chip.getByRole('button', { name: 'Enable auto-merge' }),
        ).toHaveText('Auto-merge');
        await expect(mergeButton(r)).toHaveCount(0);
        await expect(r.locator('.merge-wait')).toHaveCount(0);
        await expect(r.locator('[aria-disabled="true"]')).toHaveCount(0);
        await expect(r.getByText('Waiting for CI to finish')).toHaveCount(0);
        await expect(r.locator('.status-area')).toHaveCount(0);
        await expect(r.locator('.row-action-locked-hint')).toHaveCount(0);
        await axeClean(page);
      });

      test('a status the forge has not reported is one chip with Auto-merge and no locked Merge', async ({
        page,
      }) => {
        await open(page, [unknownStatus(1, 'Unknown'), ready(2, 'Ready')]);
        const r = row(page, 'Unknown');
        const chip = r.locator('.wait-chip');

        await expect(chip).toHaveCount(1);
        await expect(chip.locator('.wait-chip-label')).toHaveText(
          'Status unknown',
        );
        await expect(
          chip.getByRole('button', { name: 'Enable auto-merge' }),
        ).toBeVisible();
        await expect(mergeButton(r)).toHaveCount(0);
        await expect(r.locator('[aria-disabled="true"]')).toHaveCount(0);
        await expect(r.locator('.status-area')).toHaveCount(0);
        await expect(r.getByText('Merge status not known yet')).toHaveCount(0);
        await expect(chip).toHaveAccessibleDescription(
          /hasn't said yet whether it merges/,
        );
        await axeClean(page);
      });

      test('a draft keeps its locked Merge and its reason', async ({
        page,
      }) => {
        await open(page, [draftBlock]);
        const r = row(page, 'Draft');
        await expect(r.locator('.wait-chip')).toHaveCount(0);
        await expect(
          r.locator('[aria-disabled="true"]').filter({ hasText: 'Merge' }),
        ).toHaveCount(1);
        await expect(r.getByText('Draft pull request')).toBeVisible();
      });

      test('an armed row is the same chip with Cancel auto-merge', async ({
        page,
      }) => {
        await open(page, [armedWait(1, 'Armed')]);
        const chip = row(page, 'Armed').locator('.wait-chip');
        await expect(chip).toHaveCount(1);
        await expect(chip.locator('.wait-chip-label')).toHaveText(
          'Waiting for CI',
        );
        await expect(
          chip.getByRole('button', { name: 'Cancel auto-merge' }),
        ).toHaveText('Cancel auto-merge');
        await expect(
          chip.getByRole('button', { name: 'Enable auto-merge' }),
        ).toHaveCount(0);
        await axeClean(page);
      });

      test('the extra words open on keyboard focus and describe the chip', async ({
        page,
      }) => {
        await open(page, [offered(1, 'Waiting')]);
        const chip = row(page, 'Waiting').locator('.wait-chip');
        const tip = chip.locator('.wait-chip-tip');

        await expect(tip).toHaveCSS('opacity', '0');
        await chip.focus();
        await expect(chip).toBeFocused();
        await expect(tip).toHaveCSS('opacity', '1');
        await expect(tip).toContainText('CI is still running');
        await expect(chip).toHaveAccessibleDescription(/CI is still running/);
        await expect(chip).not.toHaveAttribute('title', /.+/);
      });

      test('no waiting or armed row is taller than a normal row', async ({
        page,
      }) => {
        test.skip(width < 1024, 'the phone card stacks the chip by design');
        await open(page, [
          offered(1, 'Pending'),
          armedWait(2, 'Armed'),
          ready(3, 'Ready'),
        ]);
        const normal = await heightOf(page, 'Ready');
        expect(await heightOf(page, 'Pending')).toBeLessThanOrEqual(normal + 1);
        // The armed row says it once, in the wait chip: no attribute chip
        // under the title, so the whole row keeps a normal row's height.
        expect(await heightOf(page, 'Armed')).toBeLessThanOrEqual(normal + 1);
        await expect(
          row(page, 'Armed').locator('.attr-chip.auto-merge'),
        ).toHaveCount(0);
      });

      test('Forgejo checking for conflicts is the same chip', async ({
        page,
      }) => {
        await open(page, [checking]);
        const r = row(page, 'Checking');
        await expect(r.locator('.wait-chip .wait-chip-label')).toHaveText(
          'Checking for conflicts',
        );
        await expect(mergeButton(r)).toHaveCount(0);
      });

      test('Update branch stays a button beside the chip', async ({ page }) => {
        await open(page, [
          {
            ...offered(1, 'Behind', [{ action: 'update_branch' }]),
            behind: true,
          },
          ready(2, 'Ready'),
        ]);
        const r = row(page, 'Behind');
        await expect(r.locator('.wait-chip')).toHaveCount(1);
        await expect(
          r.getByRole('button', { name: /^Update branch/ }),
        ).toBeVisible();
        // One line from a 1280px window up; a narrower list stacks its cell.
        if (width >= 1280)
          expect(await heightOf(page, 'Behind')).toBeLessThanOrEqual(
            (await heightOf(page, 'Ready')) + 1,
          );
        // With no pills and no labels the one line leaves the title 200px.
        if (width >= 1280)
          expect(
            await r.locator('.title-cell').evaluate((e) => e.clientWidth),
          ).toBeGreaterThanOrEqual(200);
      });

      test('a row with a comment pill and Update branch is no taller than the same row with Merge', async ({
        page,
      }) => {
        test.skip(width < 1024, 'the phone card stacks the chip by design');
        const comments = { reviewComments: 3, unresolvedThreads: 1 };
        await open(page, [
          {
            ...offered(1, 'Commented', [{ action: 'update_branch' }]),
            behind: true,
            ...comments,
          },
          {
            ...ready(2, 'Normal'),
            behind: true,
            ...comments,
            allowedActions: [
              { action: 'merge', primary: true },
              { action: 'update_branch' },
              { action: 'close' },
            ],
          },
        ]);
        const r = row(page, 'Commented');
        await expect(r.locator('.review-pill')).toBeVisible();
        await expect(r.locator('.wait-chip')).toHaveCount(1);
        await expect(
          r.getByRole('button', { name: /^Update branch/ }),
        ).toBeVisible();
        // From 1280px the chip, the pill and the button on one line left the
        // title 70px, so the chip takes a line of its own there (#4795): one
        // 36px line taller than the Merge row, and the title keeps 200px.
        const merge = await heightOf(page, 'Normal');
        if (width >= 1280) {
          expect(await heightOf(page, 'Commented')).toBeLessThanOrEqual(
            merge + 37,
          );
          const title = await r
            .locator('.title-cell')
            .evaluate((e) => e.getBoundingClientRect().width);
          expect(title).toBeGreaterThanOrEqual(200);
        } else {
          expect(await heightOf(page, 'Commented')).toBeLessThanOrEqual(
            merge + 1,
          );
        }
      });

      test('a waiting row that cannot arm has no button and a tooltip that does not offer one', async ({
        page,
      }) => {
        await open(page, [
          pr(1, 'No arming', {
            status: CI_BLOCK,
            allowedActions: [
              { action: 'merge', blocked: CI_BLOCK },
              { action: 'close' },
            ],
          }),
        ]);
        const chip = row(page, 'No arming').locator('.wait-chip');
        await expect(chip).toHaveCount(1);
        await expect(chip.locator('.wait-chip-label')).toHaveText(
          'Waiting for CI',
        );
        await expect(chip.getByRole('button')).toHaveCount(0);
        await expect(chip).toHaveAccessibleDescription(/CI is still running/);
        await expect(chip.locator('.wait-chip-tip')).not.toContainText(
          /auto-merge/i,
        );
      });

      test('a queued action keeps its chip while CI is still running', async ({
        page,
      }) => {
        await open(page, [
          {
            ...offered(1, 'Queued', [{ action: 'update_branch' }]),
            behind: true,
            queued: {
              id: 'q1',
              action: 'update_branch',
              forge: 'github',
              fullName: 'alrayyes/app',
              number: 1,
              status: 'queued',
              runAt: new Date(Date.now() + 20 * 60_000).toISOString(),
              createdAt: new Date().toISOString(),
            },
          },
        ]);
        const chip = row(page, 'Queued').locator('.wait-chip');
        await expect(chip).toHaveCount(1);
        await expect(chip).toHaveAttribute('data-source', 'queued');
        await expect(
          chip.getByRole('button', { name: /^Cancel queued update/ }),
        ).toBeVisible();
      });

      test('there is no dead stop on a locked control when tabbing', async ({
        page,
      }) => {
        await open(page, [offered(1, 'Waiting')]);
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
          await expect(r.locator('.wait-chip')).toHaveCount(0);
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
    await open(page, [offered(1, 'Mine'), offered(2, 'Other')]);
    await row(page, 'Mine').locator('button.title').focus();

    await push(page, [ready(1, 'Mine'), offered(2, 'Other')]);

    await expect(mergeButton(row(page, 'Mine'))).toBeVisible();
    await expect(page.locator('#list-updates-status')).toHaveText(
      'Merge is available.',
    );
  });

  test('a row that unlocks in the background announces nothing', async ({
    page,
  }) => {
    await open(page, [offered(1, 'Mine'), offered(2, 'Other')]);
    await row(page, 'Mine').locator('button.title').focus();

    await push(page, [offered(1, 'Mine'), ready(2, 'Other')]);

    await expect(mergeButton(row(page, 'Other'))).toBeVisible();
    expect(await announced(page)).toBe('');
  });

  test('nobody focused on the board hears nothing', async ({ page }) => {
    await open(page, [offered(1, 'Mine')]);
    await push(page, [ready(1, 'Mine')]);
    await expect(mergeButton(row(page, 'Mine'))).toBeVisible();
    expect(await announced(page)).toBe('');
  });
});

// A dependency bot's row gets its rebase button where a person's gets Update
// branch, and the same chip beside it, no taller than a bot row without one.
for (const width of [1280, 1024]) {
  test(`a bot row with a rebase button and the chip is no taller than one without, ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const bot = (n: number, title: string, over: Record<string, unknown>) =>
      pr(n, title, {
        author: 'dependabot[bot]',
        kind: 'dependency',
        behind: true,
        ...over,
      });
    await open(
      page,
      [
        bot(1, 'Waiting bump', {
          status: CI_BLOCK,
          allowedActions: [
            { action: 'merge', blocked: CI_BLOCK },
            { action: 'auto_merge' },
            { action: 'dependabot_rebase', primary: true },
            { action: 'close' },
          ],
        }),
        bot(2, 'Plain bump', {
          ci: 'success',
          mergeStatus: 'mergeable',
          allowedActions: [
            { action: 'merge', primary: true },
            { action: 'dependabot_rebase' },
            { action: 'close' },
          ],
        }),
      ],
      '/bots.html',
    );
    const r = row(page, 'Waiting bump');
    await expect(r.locator('.wait-chip')).toHaveCount(1);
    await expect(
      r
        .locator('.wait-chip')
        .getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeVisible();
    await expect(
      r.locator('.row-action-bar').getByRole('button').first(),
    ).toBeVisible();
    await expect(r.locator('.row-action-bar')).toContainText(/Rebase/);
    expect(await heightOf(page, 'Waiting bump')).toBeLessThanOrEqual(
      (await heightOf(page, 'Plain bump')) + 1,
    );
    // No pills, and an unarmed chip with its own button: the one line leaves
    // the title 145px at 1280px. The rule is a 200px title floor except bot
    // rows (#4795, owner decision 2026-11-26): a bot row has no room to give
    // and stacking it would make every bot row two lines. This 140px floor
    // pins the exception so it cannot shrink.
    if (width >= 1280)
      expect(
        await r.locator('.title-cell').evaluate((e) => e.clientWidth),
      ).toBeGreaterThanOrEqual(140);
  });
}

test.describe('a status that stays unknown', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('says Still waiting after two minutes and points at the forge', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    await open(page, [unknownStatus(1, 'Unknown')]);
    const chip = row(page, 'Unknown').locator('.wait-chip');
    await expect(chip.locator('.wait-chip-label')).toHaveText('Status unknown');

    await page.clock.fastForward(130_000);
    await push(page, [unknownStatus(1, 'Unknown')]);

    await expect(chip.locator('.wait-chip-label')).toHaveText('Still waiting');
    await expect(chip).toHaveAccessibleDescription(
      /Open the pull request on the forge/,
    );
    await expect(
      chip.getByRole('button', { name: 'Enable auto-merge' }),
    ).toBeVisible();
    await axeClean(page);
  });

  test('turns to Still waiting by itself when nothing about the row changes', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    await open(page, [unknownStatus(1, 'Unknown')]);
    const label = row(page, 'Unknown').locator('.wait-chip-label');
    await expect(label).toHaveText('Status unknown');

    await page.clock.fastForward(130_000);

    await expect(label).toHaveText('Still waiting');
  });

  test('a pull request that leaves the snapshot and comes back starts the clock again', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    await open(page, [unknownStatus(1, 'Unknown'), ready(2, 'Ready')]);
    const label = row(page, 'Unknown').locator('.wait-chip-label');
    await page.clock.fastForward(130_000);
    await push(page, [unknownStatus(1, 'Unknown'), ready(2, 'Ready')]);
    await expect(label).toHaveText('Still waiting');

    await push(page, [ready(2, 'Ready')]);
    await expect(row(page, 'Unknown')).toHaveCount(0);
    await push(page, [unknownStatus(1, 'Unknown'), ready(2, 'Ready')]);
    await expect(label).toHaveText('Status unknown');
  });

  test('a flip to ready and back to unknown starts the clock again', async ({
    page,
  }) => {
    await page.clock.install({ time: new Date() });
    await open(page, [unknownStatus(1, 'Unknown')]);
    const label = row(page, 'Unknown').locator('.wait-chip-label');
    await page.clock.fastForward(130_000);
    await push(page, [unknownStatus(1, 'Unknown')]);
    await expect(label).toHaveText('Still waiting');

    await push(page, [ready(1, 'Unknown')]);
    await expect(mergeButton(row(page, 'Unknown'))).toBeVisible();
    await push(page, [unknownStatus(1, 'Unknown')]);
    await expect(label).toHaveText('Status unknown');
  });

  test('gives Merge back when the forge reports, with no row jump', async ({
    page,
  }) => {
    await open(page, [unknownStatus(1, 'Unknown')]);
    const before = await heightOf(page, 'Unknown');
    await push(page, [ready(1, 'Unknown')]);

    await expect(mergeButton(row(page, 'Unknown'))).toBeVisible();
    await expect(row(page, 'Unknown').locator('.wait-chip')).toHaveCount(0);
    expect(Math.abs((await heightOf(page, 'Unknown')) - before)).toBeLessThan(
      2,
    );
  });
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test.describe(`a status that stays unknown, ${scheme}, ${width}px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
      });

      test('the Still waiting chip fits the row, keeps Auto-merge and passes axe', async ({
        page,
      }) => {
        await page.clock.install({ time: new Date() });
        await open(page, [unknownStatus(1, 'Unknown'), ready(2, 'Ready')]);
        const before = await heightOf(page, 'Unknown');
        await page.clock.fastForward(130_000);
        await push(page, [unknownStatus(1, 'Unknown'), ready(2, 'Ready')]);

        const chip = row(page, 'Unknown').locator('.wait-chip');
        await expect(chip.locator('.wait-chip-label')).toHaveText(
          'Still waiting',
        );
        await expect(
          chip.getByRole('button', { name: 'Enable auto-merge' }),
        ).toBeVisible();
        expect(
          Math.abs((await heightOf(page, 'Unknown')) - before),
        ).toBeLessThan(2);
        const box = await chip.boundingBox();
        expect(box && box.x + box.width).toBeLessThanOrEqual(width);
        await axeClean(page);
      });
    });
  }
}
