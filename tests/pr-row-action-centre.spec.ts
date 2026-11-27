import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { rateLimit } from './rate-limit-mock';
import { test } from './server-fixture';

// Every cell of a pull request row sits on the row's vertical middle: the
// status pill, the comments pill, the author, the dates and the action area
// (the waiting chip, Merge, Cancel auto-merge, Update branch). A row waiting
// on CI had its chip lower than the pills, so it read as two lines (#4945).
// https://github.com/alrayyes/forge-dashboard/issues/4945

const TOLERANCE = 1;
const COMMENTS = { reviewComments: 4, unresolvedThreads: 1 };
const LABELS = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'needs-review', color: 'fbca04' },
];
const WAITING = {
  state: 'waiting',
  code: 'checks_pending',
  message: 'Auto-merge is waiting for the checks to finish.',
};

const RUNNING = {
  ci: 'pending',
  checks: { passed: 4, running: 2, waiting: 0, failed: 0 },
};

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'example-org/api-gateway',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'demo-user',
    draft: false,
    ci: 'success',
    checks: { passed: 13, running: 0, waiting: 0, failed: 0 },
    labels: [],
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
    ...overrides,
  };
}

const BLOCKED = (code: string) => ({
  action: 'merge',
  blocked: { code, message: 'Waiting' },
});

// What the server lists for an armed pull request: Cancel is never primary
// (markPrimary only picks Merge, Update branch, a bot rebase or Close).
const ARMED = {
  ...RUNNING,
  autoMergeEnabled: true,
  autoMerge: WAITING,
  allowedActions: [
    BLOCKED('checks_pending'),
    { action: 'close' },
    { action: 'cancel_auto_merge' },
  ],
};

const ROWS = [
  pr(1, { title: 'Merge', ...COMMENTS }),
  pr(2, { title: 'Waiting chip', ...COMMENTS, ...ARMED }),
  pr(3, { title: 'Armed without comments', ...ARMED }),
  pr(4, {
    title: 'Update branch beside Merge',
    ...COMMENTS,
    behind: true,
    allowedActions: [
      { action: 'merge', primary: true },
      { action: 'update_branch' },
      { action: 'close' },
    ],
  }),
  pr(5, {
    title: 'Labels under the title',
    ...COMMENTS,
    labels: LABELS,
    ...ARMED,
  }),
  pr(6, { title: 'Labels with Merge', ...COMMENTS, labels: LABELS }),
];

async function open(
  page: Page,
  width: number,
  prs = ROWS,
  path = '/pull-requests.html',
  forges = [forgeHealth('github')],
) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
        pullRequests: prs,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(path);
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
}

interface Measure {
  title: string;
  height: number;
  centres: Record<string, number>;
}

async function measure(page: Page): Promise<Measure[]> {
  return page.locator('#pr-rows > .row').evaluateAll((rows) =>
    rows.map((r) => {
      const centres: Record<string, number> = {};
      for (const s of [
        '.ci-pill',
        '.review-pill',
        '.author',
        '.created',
        '.updated',
        '.wait-chip',
        '.row-action-bar button',
      ]) {
        const e = r.querySelector(s);
        const b = e?.getBoundingClientRect();
        if (b && b.height > 0) centres[s] = b.top + b.height / 2;
      }
      return {
        title: r.querySelector('.title-text')?.textContent ?? '',
        height: r.getBoundingClientRect().height,
        centres,
      };
    }),
  );
}

for (const width of [1280, 390]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, width);
    });

    test('the pills and the action area share one vertical centre', async ({
      page,
    }) => {
      // A phone card stacks the action under a divider and keeps its own
      // tiers, so only its pills share a line.
      const phone = width < 600;
      // On the one-line layout a chip beside pills has a line of its own,
      // because every row shares the columns (#5006). The author and dates
      // then centre on both lines.
      await expect
        .poll(async () =>
          (await measure(page)).flatMap((m) => {
            const pill = m.centres['.ci-pill'];
            const stacked = m.centres['.wait-chip'] - pill > TOLERANCE;
            const beside = ['.review-pill', '.row-action-bar'];
            return Object.entries(m.centres)
              .filter(([n]) => !stacked || beside.includes(n))
              .filter(([n]) => !phone || ['.review-pill'].includes(n))
              .filter(
                ([n, c]) => n !== '.ci-pill' && Math.abs(c - pill) > TOLERANCE,
              )
              .map(([n, c]) => `${m.title}: ${n} ${c} vs status pill ${pill}`);
          }),
        )
        .toEqual([]);
    });

    test('a chip beside pills adds one line at most', async ({ page }) => {
      test.skip(width < 600, 'a phone card has its own tiers');
      await expect
        .poll(async () => {
          const m = await measure(page);
          const h = (t: string) => m.find((x) => x.title.endsWith(t))!.height;
          return [
            h('Waiting chip') - h('Merge'),
            h('Labels under the title') - h('Labels with Merge'),
          ].every((d) => d <= 36);
        })
        .toBe(true);
    });

    test('the rows have no axe violations', async ({ page }) => {
      const results = await new AxeBuilder({ page })
        .include('#pr-rows')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}

// #4971: an armed row's action column holds Cancel auto-merge and nothing
// else. Merge, Update branch and the bot's rebase and recreate stay in the
// details dialog. These are the action sets the server sends, with the status
// it derives from a locked Merge.
interface Variant {
  name: string;
  path?: string;
  pr: Record<string, unknown>;
  // What the dialog still offers besides Cancel: a button, or (a
  // Merge dropped while CI runs) what it says instead.
  inDialog: { button: RegExp } | { text: string };
}

const VARIANTS: Variant[] = [
  {
    name: 'waiting for CI',
    pr: ARMED,
    inDialog: { text: 'Waiting for CI' },
  },
  {
    name: 'a locked Merge waiting for review',
    pr: {
      ...ARMED,
      ci: 'success',
      checks: { passed: 13, running: 0, waiting: 0, failed: 0 },
      autoMerge: {
        state: 'waiting',
        code: 'review_required',
        message: 'Auto-merge is waiting for a review.',
      },
      status: { code: 'review_required', message: 'Waiting' },
      allowedActions: [
        BLOCKED('review_required'),
        { action: 'close' },
        { action: 'cancel_auto_merge' },
      ],
    },
    inDialog: { button: /^Merge/ },
  },
  {
    name: 'a live Merge on an unstable pull request',
    pr: {
      ...ARMED,
      ci: 'success',
      checks: { passed: 13, running: 0, waiting: 0, failed: 0 },
      mergeStatus: 'unstable',
      allowedActions: [
        { action: 'merge', primary: true },
        { action: 'close' },
        { action: 'cancel_auto_merge' },
      ],
    },
    inDialog: { button: /^Merge/ },
  },
  {
    name: 'a branch behind its base',
    pr: {
      ...ARMED,
      behind: true,
      autoMerge: {
        state: 'waiting',
        code: 'behind',
        message: 'Auto-merge is waiting for the branch to be updated.',
      },
      status: {
        code: 'behind',
        message: 'Behind the base branch',
        action: 'update_branch',
      },
      allowedActions: [
        BLOCKED('behind'),
        { action: 'close' },
        { action: 'update_branch', primary: true },
        { action: 'cancel_auto_merge' },
      ],
    },
    inDialog: { button: /^Update branch/ },
  },
  {
    name: 'a behind Dependabot pull request',
    path: '/bots.html',
    pr: {
      ...ARMED,
      author: 'dependabot[bot]',
      kind: 'dependency',
      behind: true,
      status: {
        code: 'behind',
        message: 'Behind the base branch',
        action: 'dependabot_rebase',
      },
      allowedActions: [
        BLOCKED('behind'),
        { action: 'close' },
        { action: 'dependabot_rebase', primary: true },
        { action: 'dependabot_recreate' },
        { action: 'cancel_auto_merge' },
      ],
    },
    inDialog: { button: /rebase/i },
  },
  {
    name: 'a stopped auto-merge',
    pr: {
      ...ARMED,
      ci: 'success',
      checks: { passed: 13, running: 0, waiting: 0, failed: 0 },
      autoMerge: {
        state: 'stopped',
        code: 'merge_refused',
        message: 'The forge refused the merge.',
      },
      allowedActions: [
        { action: 'merge', primary: true },
        { action: 'close' },
        { action: 'cancel_auto_merge' },
      ],
    },
    inDialog: { button: /^Merge/ },
  },
];
const PULLS = VARIANTS.filter((v) => !v.path);

for (const variant of VARIANTS) {
  test(`${variant.name}: the column holds only Cancel, the rest is in the dialog`, async ({
    page,
  }) => {
    await open(page, 1280, [pr(7, variant.pr)], variant.path);
    const row = page.locator('#pr-rows > .row');
    const buttons = row.locator('.row-action-bar button');
    await expect(buttons).toHaveCount(1);
    await expect(buttons).toHaveAccessibleName('Cancel auto-merge');
    await expect(buttons).toHaveText('Cancel');
    // Nowhere else on the row either: the behind warning keeps its words and
    // leaves its fix to the dialog.
    await expect(
      row.getByRole('button', {
        name: /^(Merge|Update branch|Rebase|Recreate|Dependabot|Renovate)/,
      }),
    ).toHaveCount(0);
    await row.locator("button[id^='details-trigger-']").click();
    const dialog = page.getByRole('dialog');
    if ('button' in variant.inDialog)
      await expect(
        dialog.getByRole('button', { name: variant.inDialog.button }).first(),
      ).toBeVisible();
    else await expect(dialog).toContainText(variant.inDialog.text);
    await expect(
      dialog.getByRole('button', { name: 'Cancel auto-merge' }),
    ).toBeVisible();
  });
}

// Every armed variant, with and without labels and a comment pill, beside a
// Merge row of the same shape: nothing on top of anything else, the title keeps
// its 200px on a one-line list (#4795), and a row with nothing more under its
// title is no taller there (#4945).
const SHAPES = [
  { name: 'bare', extra: {} },
  { name: 'labels', extra: { labels: LABELS } },
  { name: 'comments', extra: COMMENTS },
  { name: 'labels and comments', extra: { labels: LABELS, ...COMMENTS } },
];

async function geometry(page: Page) {
  return page.locator('#pr-rows > .row').evaluateAll((all) =>
    all.map((r) => {
      const parts = [
        '.ci-pill',
        '.status-flags',
        '.wait-chip',
        '.row-action-bar button',
      ].flatMap((s) => {
        const b = r.querySelector(s)?.getBoundingClientRect();
        return b && b.width > 0 ? [{ s, b }] : [];
      });
      const overlaps = parts.flatMap((a, i) =>
        parts
          .slice(i + 1)
          .flatMap((c) =>
            a.b.left < c.b.right - 0.5 &&
            c.b.left < a.b.right - 0.5 &&
            a.b.top < c.b.bottom - 0.5 &&
            c.b.top < a.b.bottom - 0.5
              ? [`${a.s} over ${c.s}`]
              : [],
          ),
      );
      return {
        title: r.querySelector('.title-text')?.textContent ?? '',
        height: r.getBoundingClientRect().height,
        titleWidth: r.querySelector('.title-cell')!.clientWidth,
        under:
          r.querySelector(
            '.status-area, .title-cell .attr-chip:not(.label-chip)',
          )?.textContent ?? '',
        overlaps,
      };
    }),
  );
}

for (const width of [1000, 1280, 1503]) {
  for (const shape of SHAPES) {
    test(`armed rows fit beside a Merge row, ${shape.name}, at ${width}px`, async ({
      page,
    }) => {
      await open(page, width, [
        pr(1, { title: 'Merge', ...shape.extra }),
        ...PULLS.map((v, i) =>
          pr(i + 2, { title: v.name, ...v.pr, ...shape.extra }),
        ),
      ]);
      await expect(page.locator('.wait-chip')).toHaveCount(PULLS.length);
      const rows = await geometry(page);
      const merge = rows.find((r) => r.title.endsWith('Merge'))!;
      const trace = JSON.stringify(rows);
      for (const r of rows) {
        expect(r.overlaps, `${r.title}: ${trace}`).toEqual([]);
        // The floor is a one-line list's (#4795); a narrower one stacks.
        if (width >= 1280)
          expect(r.titleWidth, `${r.title}: ${trace}`).toBeGreaterThanOrEqual(
            200,
          );
        // From 1280px a row with a flags pill or a wide CI pill takes a second
        // line, since every row shares the list's columns (#5006). A narrower list
        // wraps the cell, where Cancel's line costs a few pixels. A row with a
        // reason line (under the title, or in a wrapped cell) is taller by
        // that line.
        if (!r.under)
          expect(
            r.height - merge.height,
            `${r.title}: ${trace}`,
          ).toBeLessThanOrEqual(width >= 1280 ? 36 : 8);
      }
    });
  }
}

// #4971, whatever an armed row waits for: with a short CI pill and no flags
// pill its chip and Cancel stay on the pill's line, and otherwise they make one
// line under the pills, since the list's columns are shared (#5006). Either way
// the CI pill and Cancel start where a Merge row's CI pill and Merge button do,
// and the order on screen is the order Tab takes: the CI pill, the pills, the
// chip, Cancel. `label` is the wait in full, which the chip's tooltip has.
const green = {
  ci: 'success',
  checks: { passed: 13, running: 0, waiting: 0, failed: 0 },
};
const waiting = (code: string, extra: Record<string, unknown> = {}) => ({
  ...ARMED,
  ...green,
  autoMerge: {
    state: 'waiting',
    code,
    message: 'Auto-merge is waiting for something to happen first.',
  },
  allowedActions: [
    BLOCKED(code || 'unknown'),
    { action: 'close' },
    { action: 'cancel_auto_merge' },
  ],
  ...extra,
});
const DETAILS = [
  { label: 'Waiting for forge', pr: waiting('something_else') },
  { label: 'Waiting for update', pr: waiting('behind', { behind: true }) },
  { label: 'Waiting for ready', pr: waiting('draft', { draft: true }) },
  { label: 'Waiting for parent', pr: waiting('stacked') },
  {
    label: 'Waiting for review',
    pr: waiting('review_required', { review: { decision: 'review_required' } }),
  },
  {
    label: 'Changes requested',
    pr: waiting('changes_requested', {
      review: { decision: 'changes_requested' },
    }),
  },
  { label: 'Waiting for rule', pr: waiting('blocked_by_protection') },
  { label: 'Rate limited', pr: waiting('rate_limited') },
  { label: 'Merging', pr: waiting('') },
];

for (const width of [1280, 1503, 1920]) {
  for (const shape of SHAPES) {
    test(`every armed wait keeps the columns, ${shape.name}, at ${width}px`, async ({
      page,
    }) => {
      await open(page, width, [
        pr(1, { title: 'Merge', ...shape.extra }),
        ...DETAILS.map((v, i) =>
          pr(i + 2, { title: v.label, ...v.pr, ...shape.extra }),
        ),
      ]);
      await expect(page.locator('.wait-chip')).toHaveCount(DETAILS.length);
      for (const v of DETAILS) {
        const chip = page
          .locator('#pr-rows > .row')
          .filter({ has: page.locator('.title-text', { hasText: v.label }) })
          .locator('.wait-chip');
        await expect(chip.locator('.wait-chip-label')).toHaveText(
          v.label === 'Merging' ? 'Merging' : 'Auto-merge on',
        );
        await expect(chip).toContainText(v.label);
        // The chip's slot shares the pill's line and must not lie over it: the
        // pill still takes the pointer.
        await page
          .locator('#pr-rows > .row')
          .filter({ has: page.locator('.title-text', { hasText: v.label }) })
          .locator('.ci-pill')
          .click({ trial: true, timeout: 2000 });
      }
      const rows = await page.locator('#pr-rows > .row').evaluateAll((all) =>
        all.map((r) => {
          const box = (s: string) =>
            r.querySelector(s)?.getBoundingClientRect();
          const ci = box('.ci-pill')!;
          const flags = box('.status-flags');
          const chip = box('.wait-chip');
          const button = box('.row-action-bar button')!;
          return {
            title: r.querySelector('.title-text')?.textContent ?? '',
            cell: box('.status-cell')!.height,
            titleWidth: r.querySelector('.title-cell')!.clientWidth,
            overflow: r.scrollWidth - r.clientWidth,
            // A flags pill, or a CI pill with two counts or more, leaves no
            // room beside it.
            second:
              (flags?.width ?? 0) > 0 ||
              r.querySelectorAll('.ci-pill .ci-seg').length >= 3,
            ciRight: ci.right,
            ciCentre: ci.top + ci.height / 2,
            ciLeft: ci.left,
            actionLeft: button.left,
            // The foot of the first line: the CI pill and the other pills.
            pillsBottom: Math.max(
              ci.bottom,
              flags && flags.width > 0 ? flags.bottom : 0,
            ),
            chip: chip && {
              top: chip.top,
              left: chip.left,
              right: chip.right,
              centre: chip.top + chip.height / 2,
            },
            actionCentre: button.top + button.height / 2,
          };
        }),
      );
      const merge = rows.find((r) => r.title.endsWith('Merge'))!;
      const trace = JSON.stringify(rows);
      for (const r of rows) {
        const at = `${r.title}: ${trace}`;
        expect(r.titleWidth, at).toBeGreaterThanOrEqual(200);
        expect(r.overflow, at).toBeLessThanOrEqual(0);
        expect(Math.abs(r.ciLeft - merge.ciLeft), at).toBeLessThanOrEqual(1);
        expect(
          Math.abs(r.actionLeft - merge.actionLeft),
          at,
        ).toBeLessThanOrEqual(1);
        if (!r.chip) continue;
        expect(
          Math.abs(r.chip.centre - r.actionCentre),
          at,
        ).toBeLessThanOrEqual(TOLERANCE);
        expect(r.actionLeft - r.chip.right, at).toBeGreaterThanOrEqual(0);
        if (r.second) {
          expect(r.chip.top, at).toBeGreaterThanOrEqual(r.pillsBottom - 1);
          // One line more than a Merge row, never two.
          expect(r.cell - merge.cell, at).toBeLessThanOrEqual(36);
        } else {
          expect(Math.abs(r.chip.centre - r.ciCentre), at).toBeLessThanOrEqual(
            TOLERANCE,
          );
          expect(r.chip.left - r.ciRight, at).toBeGreaterThanOrEqual(0);
          expect(r.cell - merge.cell, at).toBeLessThanOrEqual(1);
        }
      }
    });
  }
}

// The "Cancelling" chip has a detail and no button beside it, and the row it
// stands in grows no taller while the request runs.
test('cancelling auto-merge does not make the armed row taller', async ({
  page,
}) => {
  await page.route('**/api/v1/pull-requests/auto-merge/cancel', () => {});
  await open(page, 1280, [pr(2, { ...ARMED, ...COMMENTS })]);
  const row = page.locator('#pr-rows > .row');
  const height = async () => (await row.boundingBox())?.height ?? 0;
  const armed = await height();
  await row.getByRole('button', { name: 'Cancel auto-merge' }).click();
  await expect(row.locator('.wait-chip-label')).toHaveText('Cancelling');
  expect(await height()).toBeLessThanOrEqual(armed + TOLERANCE);
});

// #4971: Cancel auto-merge is the row's action, in the column Merge sits in,
// not a button inside the chip. The chip keeps its state text.
for (const scheme of ['light', 'dark'] as const) {
  for (const width of [360, 390, 1280, 1503]) {
    test(`an armed chip keeps only its text, and Cancel is the row's one action at ${width}px, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, width, [
        ROWS[1],
        ...PULLS.map((v, i) => pr(i + 10, { title: v.name, ...v.pr })),
      ]);
      const row = page.locator('#pr-rows > .row', { hasText: 'Waiting chip' });
      await expect(row.locator('.wait-chip')).toBeVisible();
      await expect(row.locator('.wait-chip button')).toHaveCount(0);
      const bar = row.locator('.row-action-bar');
      const cancel = bar.getByRole('button', { name: 'Cancel auto-merge' });
      await expect(bar.getByRole('button')).toHaveCount(1);
      await expect(cancel).toBeVisible();
      // The chip says auto-merge is on, so the button's own word is short;
      // its name is the full one (label in name, WCAG 2.5.3).
      await expect(cancel).toHaveText('Cancel');
      // A secondary button: not the teal of a primary action.
      const background = await cancel.evaluate(
        (b) => getComputedStyle(b).backgroundColor,
      );
      const accent = await page.evaluate(() => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--accent)';
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      expect(background).not.toBe(accent);
      const box = await cancel.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      if (width >= 1280) {
        const title = await row
          .locator('.title-cell')
          .evaluate((e) => e.clientWidth);
        expect(title).toBeGreaterThanOrEqual(200);
      }
      const results = await new AxeBuilder({ page })
        .include('#pr-rows')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

// The chip comes before Cancel and nothing sits between them, as when the
// button was inside the chip.
for (const width of [390, 1280]) {
  test(`Tab goes from the armed chip to Cancel at ${width}px`, async ({
    page,
  }) => {
    await open(page, width, [ROWS[1]]);
    const row = page.locator('#pr-rows > .row');
    await row.locator('.wait-chip').focus();
    await page.keyboard.press('Tab');
    await expect(
      row.getByRole('button', { name: 'Cancel auto-merge' }),
    ).toBeFocused();
  });
}

// A conflict the forge has not confirmed prints its reason, a sentence, in
// the pills' slot. It wraps there on an armed row too, and never pushes the
// title or the CI pill out of the row.
const UNCONFIRMED = {
  ...ARMED,
  forge: 'forgejo',
  ci: 'success',
  checks: { passed: 13, running: 0, waiting: 0, failed: 0 },
  mergeStatus: 'conflicting',
  conflictConfirmed: false,
  behind: true,
  outOfDate: true,
  autoMerge: {
    state: 'stopped',
    code: 'conflict',
    message: 'Auto-merge stopped: conflicts with the base branch.',
  },
  status: { code: 'conflict', message: 'Conflicts with the base branch.' },
  allowedActions: [
    BLOCKED('conflict'),
    { action: 'close' },
    { action: 'cancel_auto_merge' },
  ],
};

for (const width of [1191, 1280, 1440]) {
  for (const shape of [SHAPES[0], SHAPES[2]]) {
    test(`an armed unconfirmed conflict stays inside its row, ${shape.name}, at ${width}px`, async ({
      page,
    }) => {
      await open(
        page,
        width,
        [pr(7, { ...UNCONFIRMED, ...shape.extra })],
        '/pull-requests.html',
        [forgeHealth('forgejo')],
      );
      const row = page.locator('#pr-rows > .row');
      await expect(row.locator('.merge-pill.unconfirmed')).toBeVisible();
      const box = await row.evaluate((r) => {
        const own = r.getBoundingClientRect();
        return {
          title: r.querySelector('.title-cell')!.clientWidth,
          outside: [...r.querySelectorAll('.status-cell *')]
            .filter((e) => {
              const b = e.getBoundingClientRect();
              return (
                b.width > 0 &&
                (b.left < own.left - 1 || b.right > own.right + 1)
              );
            })
            .map((e) => e.className),
        };
      });
      expect(box.outside).toEqual([]);
      // 1191px is the narrowest one-line list, where every row's title is a
      // pixel under the floor (#4795).
      expect(box.title).toBeGreaterThanOrEqual(width >= 1280 ? 200 : 199);
    });
  }
}

// #4971: the one action holds while the forge's budget is spent, and while an
// action is queued. What else there is to press is in the dialog.
const BEHIND_ARMED = VARIANTS.find(
  (v) => v.name === 'a branch behind its base',
)!.pr;

test('a rate limited armed row offers no queue button, the dialog does', async ({
  page,
}) => {
  const spent = rateLimit(
    5000,
    0,
    new Date(Date.now() + 20 * 60_000).toISOString(),
  );
  await open(page, 1280, [pr(7, BEHIND_ARMED)], '/pull-requests.html', [
    forgeHealth('github', { rateLimitREST: spent, rateLimitGraphQL: spent }),
  ]);
  const row = page.locator('#pr-rows > .row');
  await expect(row.locator('.status-cell button.row-action')).toHaveCount(1);
  await expect(
    row.getByRole('button', { name: 'Cancel auto-merge' }),
  ).toBeVisible();
  await row.locator("button[id^='details-trigger-']").click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: /^Queue update for/ }),
  ).toBeVisible();
});

for (const state of ['stopped', 'waiting']) {
  test(`an armed, ${state} row with a queued update has one Cancel, the queue's is in the dialog`, async ({
    page,
  }) => {
    const queued = {
      id: 'q7',
      action: 'update_branch',
      forge: 'github',
      fullName: 'example-org/api-gateway',
      number: 7,
      status: 'queued',
      runAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    const deleted: string[] = [];
    await page.route('**/api/v1/queued-actions/*', (route: Route) => {
      deleted.push(route.request().url().split('/').pop() ?? '');
      return route.fulfill({ status: 204 });
    });
    await open(page, 1280, [
      pr(7, {
        ...BEHIND_ARMED,
        // The waiting case keeps the fixture's own wait (behind), whose
        // chip is not the Update branch swap.
        ...(state === 'stopped' && {
          autoMerge: {
            state: 'stopped',
            code: 'merge_refused',
            message: 'The forge refused the merge.',
          },
        }),
        queued,
      }),
    ]);
    const row = page.locator('#pr-rows > .row');
    await expect(row.locator('.wait-chip')).toBeVisible();
    await expect(row.locator('.status-cell button.row-action')).toHaveCount(1);
    await expect(
      row.getByRole('button', { name: 'Cancel auto-merge' }),
    ).toBeVisible();
    await row.locator("button[id^='details-trigger-']").click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Cancel queued update for/ })
      .click();
    await expect.poll(() => deleted).toEqual(['q7']);
  });
}

// #4971: the armed chip draws one short word, so a pill beside it never
// shrinks, and the rest of what it had to say is in the details dialog.
const GREEN = {
  ci: 'success',
  checks: { passed: 13, running: 0, waiting: 0, failed: 0 },
};
const SAYS = [
  {
    name: 'waiting for CI',
    pr: ARMED,
    word: 'Auto-merge on',
    says: ['Waiting for CI', WAITING.message],
  },
  {
    name: 'waiting for a review',
    pr: {
      ...ARMED,
      ...GREEN,
      review: { decision: 'review_required' },
      autoMerge: { ...WAITING, code: 'review_required', message: 'Held.' },
    },
    word: 'Auto-merge on',
    says: ['Waiting for review', 'A review is required.', 'Held.'],
  },
  {
    name: 'about to merge',
    pr: {
      ...ARMED,
      ...GREEN,
      autoMerge: { state: 'waiting', code: '', message: 'Checks passed.' },
    },
    word: 'Merging',
    says: ['Merging', 'as soon as it can.', 'Checks passed.'],
  },
  {
    name: 'stopped on failing CI',
    pr: {
      ...ARMED,
      ci: 'failure',
      checks: { passed: 11, running: 0, waiting: 0, failed: 2 },
      autoMerge: {
        state: 'stopped',
        code: 'checks_failing',
        message: 'Auto-merge stopped: a check failed.',
      },
      allowedActions: [
        {
          action: 'merge',
          blocked: {
            code: 'checks_failing',
            message: 'Blocked, CI is failing',
          },
        },
        { action: 'close' },
        { action: 'cancel_auto_merge' },
      ],
    },
    word: 'Stopped',
    says: ['Blocked, CI is failing', 'Auto-merge stopped: a check failed.'],
  },
];

for (const state of SAYS) {
  test(`${state.name}: the chip says "${state.word}" and the dialog says why`, async ({
    page,
  }) => {
    await open(page, 1280, [pr(7, state.pr)]);
    const row = page.locator('#pr-rows > .row');
    await expect(row.locator('.wait-chip-label')).toHaveText(state.word);
    await expect(row.locator('.wait-chip-detail')).toHaveText('');
    // The whole wording is still the chip's description.
    for (const words of state.says)
      await expect(row.locator('.wait-chip')).toContainText(words);
    await row.locator("button[id^='details-trigger-']").click();
    const dialog = page.getByRole('dialog');
    const block = dialog.locator('.details-auto-merge');
    for (const words of state.says) await expect(dialog).toContainText(words);
    await expect(block).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('.details-status-block')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

// Measured on the pill itself: its container can keep its width while the pill
// inside it is crushed or painted over.
for (const width of [390, 1024, 1191, 1280, 1440]) {
  test(`an armed row's comment pill is whole and uncovered at ${width}px`, async ({
    page,
  }) => {
    await open(page, width, [
      pr(1, { title: 'Merge', ...COMMENTS }),
      ...SAYS.map((s, i) => pr(i + 2, { title: s.name, ...s.pr, ...COMMENTS })),
    ]);
    await expect(page.locator('.wait-chip')).toHaveCount(SAYS.length);
    const pills = page.locator('#pr-rows .review-pill');
    await expect(pills).toHaveCount(SAYS.length + 1);
    const measured: { width: number; clipped: boolean; covered: number }[] = [];
    for (const pill of await pills.all()) {
      await pill.scrollIntoViewIfNeeded();
      measured.push(
        await pill.evaluate((el) => {
          const b = el.getBoundingClientRect();
          const y = b.top + b.height / 2;
          return {
            width: Math.round(b.width),
            clipped: el.scrollWidth > el.clientWidth,
            covered: [b.left + 2, b.left + b.width / 2, b.right - 2].filter(
              (x) => !el.contains(document.elementFromPoint(x, y)),
            ).length,
          };
        }),
      );
    }
    // As wide as the same pill on a row with no auto-merge at all.
    expect(measured).toEqual(
      measured.map(() => ({
        width: measured[0].width,
        clipped: false,
        covered: 0,
      })),
    );
  });
}

// On a phone card the chip and Cancel share one line, so an armed card is no
// taller for it.
for (const width of [320, 360, 390, 760]) {
  test(`a phone card has Cancel beside the armed chip at ${width}px`, async ({
    page,
  }) => {
    const shapes = [
      ...PULLS.map((v) => ({ title: v.name, ...v.pr })),
      ...SAYS.map((s) => ({ title: s.name, ...s.pr })),
    ];
    await open(page, width, [
      pr(1, { title: 'Merge' }),
      ...shapes.map((shape, i) => pr(i + 2, shape)),
    ]);
    await expect(page.locator('.row-action-secondary')).toHaveCount(
      shapes.length,
    );
    const rows = await page.locator('#pr-rows > .row').evaluateAll((all) =>
      all.map((r) => {
        const box = (s: string) => r.querySelector(s)?.getBoundingClientRect();
        const chip = box('.wait-chip');
        const cancel = box('.row-action-secondary');
        const label = r.querySelector('.wait-chip-label, .swap .words');
        return {
          title: r.querySelector('.title-text')?.textContent ?? '',
          overflow: r.scrollWidth - r.clientWidth,
          cut: label ? label.scrollWidth - label.clientWidth : 0,
          ciBottom: box('.ci-pill')!.bottom,
          cellBottom: box('.status-cell')!.bottom,
          chip: chip && {
            top: chip.top,
            bottom: chip.bottom,
            right: chip.right,
            centre: chip.top + chip.height / 2,
          },
          cancel: cancel && {
            left: cancel.left,
            height: cancel.height,
            centre: cancel.top + cancel.height / 2,
          },
        };
      }),
    );
    const armed = rows.slice(1);
    for (const r of armed) {
      const at = `${r.title}: ${JSON.stringify(r)}`;
      expect(r.overflow, at).toBeLessThanOrEqual(0);
      // A stopped auto-merge is a text line on a phone, with no chip.
      if (r.chip!.bottom === 0) continue;
      expect(r.cut, at).toBeLessThanOrEqual(0);
      expect(r.cancel!.height, at).toBeGreaterThanOrEqual(44);
      expect(r.chip!.top, at).toBeGreaterThanOrEqual(r.ciBottom);
      expect(
        Math.abs(r.chip!.centre - r.cancel!.centre),
        at,
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(r.cancel!.left - r.chip!.right, at).toBeGreaterThanOrEqual(0);
      // Nothing takes a line under them.
      expect(r.cellBottom - r.chip!.bottom, at).toBeLessThanOrEqual(16);
    }
  });
}
