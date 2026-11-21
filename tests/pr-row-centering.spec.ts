import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The pull request row is one vertically centred line: the CI pill, the
// comment pill, the merge-state pill and the action all share the row's
// centre, which is the centre of the title block (the title's first line when
// the title has nothing under it). Before, the status cell was one wrapping
// flex box with a reserved slot below it, so the pill sat at the top of a tall
// cell while the repo, title and times were centred (#4502). On a phone the
// card is title, meta, one line of pills, a divider and one full-width 44px
// action.
// https://github.com/alrayyes/forge-dashboard/issues/4502

const TOLERANCE = 2;

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
    ...overrides,
  };
}

const LONG =
  'fix(parser): handle nested lists with mixed indentation and a very long title that has to wrap or be cut somewhere along the row';

const PRS = [
  pr(1, { title: 'Clean row' }),
  pr(2, {
    title: 'Row with a comment pill',
    reviewComments: 4,
    unresolvedThreads: 1,
  }),
  pr(3, { title: LONG }),
  pr(4, {
    title: 'Row with labels',
    labels: [
      { name: 'bug', color: 'd73a4a' },
      { name: 'needs-review', color: 'fbca04' },
    ],
  }),
  pr(5, {
    title: 'Row waiting on CI',
    ci: 'pending',
    checks: { passed: 4, running: 2, waiting: 3, failed: 0 },
    allowedActions: [
      {
        action: 'merge',
        blocked: {
          code: 'checks_pending',
          message: 'Waiting for CI to finish',
          next: 'Merge unlocks automatically',
        },
      },
      { action: 'close' },
    ],
  }),
  pr(6, {
    title: 'Row in conflict',
    mergeStatus: 'conflicting',
    conflictConfirmed: true,
  }),
  pr(7, {
    title: 'Row that only offers Update branch',
    behind: true,
    allowedActions: [{ action: 'update_branch' }, { action: 'close' }],
  }),
  pr(8, {
    title: 'Row with failed checks and comments',
    ci: 'failure',
    checks: { passed: 8, running: 0, waiting: 0, failed: 3 },
    reviewComments: 5,
    unresolvedThreads: 2,
  }),
];

async function open(page: Page, width: number) {
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
        forges: [forgeHealth('github')],
        pullRequests: PRS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

interface Measure {
  title: string;
  rowCentre: number;
  firstLineCentre: number;
  titleBlockCentre: number;
  centres: Record<string, number>;
}

// Every box is measured once the row has settled; the page re-renders on its
// first refresh, so a box that is not there yet fails the poll, not the test.
async function measure(page: Page): Promise<Measure[]> {
  return page.locator('#pr-rows > .row').evaluateAll((rows) =>
    rows.map((r) => {
      const mid = (b: DOMRect) => b.top + b.height / 2;
      const one = (s: string) => {
        const e = r.querySelector(s);
        return e ? e.getBoundingClientRect() : null;
      };
      const rowBox = r.getBoundingClientRect();
      const titleText = r.querySelector('.title-text') as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(titleText);
      const firstLine = range.getClientRects()[0] as DOMRect;
      const cell = one('.title-cell') as DOMRect;
      const centres: Record<string, number> = {};
      for (const s of [
        '.ci-pill',
        '.review-pill',
        '.merge-pill',
        '.row-action',
        '.author',
        '.created',
        '.updated',
        '.go',
        '.repo',
      ]) {
        const b = one(s);
        if (b && b.height > 0) centres[s] = mid(b);
      }
      return {
        title: titleText.textContent ?? '',
        rowCentre: mid(rowBox),
        firstLineCentre: mid(firstLine),
        titleBlockCentre: mid(cell),
        centres,
      };
    }),
  );
}

test.describe('at 1280px', () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1280);
  });

  test('every pill and action shares the row centre', async ({ page }) => {
    await expect
      .poll(async () =>
        (await measure(page)).flatMap((m) => [
          ...Object.entries(m.centres)
            .filter(([, c]) => Math.abs(c - m.rowCentre) > TOLERANCE)
            .map(
              ([n, c]) => `${m.title}: ${n} centre ${c} vs row ${m.rowCentre}`,
            ),
          ...(m.centres['.ci-pill'] === undefined
            ? [`${m.title}: no CI pill`]
            : []),
        ]),
      )
      .toEqual([]);
  });

  test('on a row with nothing under the title, the pill is at the first line of the title', async ({
    page,
  }) => {
    await expect
      .poll(async () =>
        (await measure(page))
          .filter((r) => /Clean|comment pill|failed/.test(r.title))
          .filter(
            (m) =>
              !(
                Math.abs(m.centres['.ci-pill'] - m.firstLineCentre) <= TOLERANCE
              ),
          )
          .map((m) => m.title),
      )
      .toEqual([]);
  });

  test('the comment pill sits on the CI pill line, and the CI pills line up down the list', async ({
    page,
  }) => {
    await expect
      .poll(async () => {
        const info = await page.locator('#pr-rows > .row').evaluateAll((rows) =>
          rows.map((r) => {
            const ci = r.querySelector('.ci-pill')?.getBoundingClientRect();
            const rv = r.querySelector('.review-pill')?.getBoundingClientRect();
            return {
              ciLeft: ci?.left ?? 0,
              reviewTop: rv?.top ?? null,
              ciTop: ci?.top ?? 0,
              reviewLeft: rv?.left ?? null,
              ciRight: ci?.right ?? 0,
            };
          }),
        );
        return info.flatMap((i, n) => [
          ...(Math.abs(i.ciLeft - info[0].ciLeft) > 1
            ? [`row ${n}: CI pill is not in the column`]
            : []),
          ...(i.reviewTop !== null &&
          (Math.abs(i.reviewTop - i.ciTop) > 6 ||
            (i.reviewLeft as number) <= i.ciRight)
            ? [`row ${n}: comment pill is not on the CI pill line, after it`]
            : []),
        ]);
      })
      .toEqual([]);
  });

  test('the action buttons share one column and the page does not scroll sideways', async ({
    page,
  }) => {
    const lefts = await page
      .locator('#pr-rows > .row .row-action')
      .evaluateAll((els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().left)),
      );
    expect(lefts.length).toBeGreaterThan(2);
    expect(new Set(lefts).size).toBe(1);
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
  });
});

test.describe('at 390px', () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 390);
  });

  test('the pills share one line, the action is one full-width 44px button under a divider', async ({
    page,
  }) => {
    const info = await page.locator('#pr-rows > .row').evaluateAll((rows) =>
      rows.map((r) => {
        const box = (s: string) => r.querySelector(s)?.getBoundingClientRect();
        const ci = box('.ci-pill');
        const rv = box('.review-pill');
        const bar = r.querySelector('.row-action-bar');
        const action = box('.row-action');
        const rowBox = r.getBoundingClientRect();
        return {
          title: r.querySelector('.title-text')?.textContent ?? '',
          ciMid: ci ? ci.top + ci.height / 2 : null,
          rvMid: rv ? rv.top + rv.height / 2 : null,
          ciBottom: ci?.bottom ?? 0,
          actionTop: action?.top ?? null,
          actionHeight: action?.height ?? null,
          actionWidth: action?.width ?? null,
          barBorder: bar ? getComputedStyle(bar).borderTopWidth : null,
          rowWidth: rowBox.width,
          actions: r.querySelectorAll('.row-action-bar .row-action').length,
        };
      }),
    );
    for (const i of info) {
      expect(i.ciMid, `${i.title} has a CI pill`).not.toBeNull();
      if (i.rvMid !== null)
        expect(
          Math.abs(i.rvMid - (i.ciMid as number)),
          i.title,
        ).toBeLessThanOrEqual(TOLERANCE);
      if (i.actionTop !== null) {
        expect(i.actionHeight, i.title).toBeGreaterThanOrEqual(44);
        expect(i.actionWidth, i.title).toBeGreaterThan(i.rowWidth - 60);
        expect(i.barBorder, i.title).toBe('1px');
        expect(i.actionTop, i.title).toBeGreaterThan(i.ciBottom);
        expect(i.actions, `${i.title}: one action`).toBe(1);
      }
    }
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
  });

  test('a failed-CI row draws no action button', async ({ page }) => {
    const failed = page.locator('#pr-rows > .row', {
      hasText: 'failed checks and comments',
    });
    await expect(failed.locator('.row-action')).toHaveCount(0);
  });

  test('a row whose only action is Update branch shows just that', async ({
    page,
  }) => {
    const row = page.locator('#pr-rows > .row', {
      hasText: 'only offers Update',
    });
    await expect(row.locator('.row-action')).toHaveCount(1);
    await expect(row.locator('.row-action')).toHaveText(/Update branch/);
  });
});

// A large root font size turns the one-line row off (the container query is
// in rem), and the note then has to go back into the status cell. Left under
// the title it is squeezed into a column a few words wide and the page grows
// to several times its height.
test.describe('the one-line row and the root font size', () => {
  const noteCell = (page: Page) =>
    page
      .locator('#pr-rows > .row', { hasText: 'Row waiting on CI' })
      .locator('.status-area')
      .first()
      .evaluate((n) => ({
        inTitle: n.closest('.title-cell') !== null,
        inStatus: n.closest('.status-cell') !== null,
      }));

  test('at 1280px the note is under the title', async ({ page }) => {
    await open(page, 1280);
    await expect
      .poll(() => noteCell(page))
      .toEqual({ inTitle: true, inStatus: false });
  });

  test('at 1280px and 200% root font the note stays in the status cell', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = 'html { font-size: 200% !important; }';
      document.addEventListener('DOMContentLoaded', () =>
        document.head.appendChild(style),
      );
    });
    await open(page, 1280);
    await expect
      .poll(() => noteCell(page))
      .toEqual({ inTitle: false, inStatus: true });
  });

  test('the note follows the list when it is resized across the breakpoint', async ({
    page,
  }) => {
    await open(page, 1280);
    await expect.poll(async () => (await noteCell(page)).inTitle).toBe(true);
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(async () => (await noteCell(page)).inStatus).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(async () => (await noteCell(page)).inTitle).toBe(true);
  });
});
