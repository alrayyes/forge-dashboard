import AxeBuilder from '@axe-core/playwright';
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
          code: 'blocked_by_protection',
          message: 'A required review is missing',
          next: 'Ask a reviewer to approve',
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

// Not in PRS: its fix button sits in the status area, not on the action
// column the other rows share.
const BEHIND = pr(9, {
  title: 'Row behind with a comment pill',
  behind: true,
  mergeStatus: 'blocked',
  reviewComments: 2,
  unresolvedThreads: 1,
  allowedActions: [{ action: 'update_branch' }, { action: 'close' }],
  status: {
    code: 'behind',
    message: 'Behind the base branch',
    next: 'Bring it up to date to unlock Merge',
    action: 'update_branch',
  },
});

// A ready-to-merge row that is also behind: the server lists Merge as primary
// and Update branch beside it (#4518).
const BOTH = pr(10, {
  title: 'Row with Merge and Update branch',
  behind: true,
  allowedActions: [
    { action: 'merge', primary: true },
    { action: 'update_branch' },
    { action: 'close' },
  ],
});
const ONE = pr(11, {
  title: 'Row with Merge only',
  allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
});
async function open(page: Page, width: number, prs = PRS) {
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
        pullRequests: prs,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
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

// Merge and Update branch used to stack as one block inside the action slot,
// which made that row taller than its neighbours (#4518). They now share the
// one line, and the row is as tall as a row with a single button.
// https://github.com/alrayyes/forge-dashboard/issues/4518
// The list is 62px narrower than the window, so a 1253px window is the 1191px
// list where the one-line row starts.
for (const width of [1280, 1253]) {
  test.describe(`a row with Merge and Update branch at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, width, [ONE, BOTH]);
    });

    test('the two buttons share one line and the row is as tall as one with a single button', async ({
      page,
    }) => {
      await expect
        .poll(() =>
          page.locator('#pr-rows > .row').evaluateAll((rows) => {
            const [one, both] = rows;
            const btns = [...both.querySelectorAll('.row-action')].map((b) =>
              b.getBoundingClientRect(),
            );
            return {
              buttons: btns.length,
              sameLine:
                btns.length === 2 &&
                Math.abs(btns[0].top - btns[1].top) <= 1 &&
                btns[0].right <= btns[1].left,
              // clientHeight leaves out the last row's missing bottom border.
              heightDiff: Math.abs(both.clientHeight - one.clientHeight),
            };
          }),
        )
        .toEqual({ buttons: 2, sameLine: true, heightDiff: 0 });
    });

    test('the buttons stay inside the row and the page does not scroll sideways', async ({
      page,
    }) => {
      await expect
        .poll(() =>
          page.locator('#pr-rows > .row').evaluateAll((rows) => {
            const row = rows[1].getBoundingClientRect();
            const cell = rows[1]
              .querySelector('.status-cell')
              ?.getBoundingClientRect() as DOMRect;
            return [...rows[1].querySelectorAll('.row-action')]
              .map((b) => b.getBoundingClientRect())
              .filter(
                (b) =>
                  b.right > row.right + 0.5 ||
                  b.left < cell.left - 0.5 ||
                  b.right > cell.right + 0.5,
              ).length;
          }),
        )
        .toBe(0);
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(over).toBeLessThanOrEqual(0);
    });
  });
}

// From 761px to 1190px of list width the status cell is still the wrapping
// flex box, with the note on a line of its own. The pill line then sat above
// the row's centre by half the note's height, while the title was centred
// (#4517). The repo, title and arrow now start at the top of the row, so the
// CI pill and the title's first line share a centre at every width, with or
// without a note. The other pills and the action stay in the stack below.
// https://github.com/alrayyes/forge-dashboard/issues/4517
for (const width of [761, 1000, 1190]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, width);
    });

    test('the CI pill is on the title centre line, with or without a note', async ({
      page,
    }) => {
      await expect
        .poll(async () =>
          (await measure(page))
            .filter(
              (m) => !/Row with labels|Row that only offers/.test(m.title),
            )
            .filter((m) =>
              /Clean|comment pill|waiting on CI|conflict|failed/.test(m.title),
            )
            .flatMap((m) => [
              ...(m.centres['.ci-pill'] === undefined
                ? [`${m.title}: no CI pill`]
                : []),
              ...(Math.abs(m.centres['.ci-pill'] - m.firstLineCentre) >
              TOLERANCE
                ? [
                    `${m.title}: CI pill ${m.centres['.ci-pill']} vs title ${m.firstLineCentre}`,
                  ]
                : []),
            ]),
        )
        .toEqual([]);
    });

    test('the repo and the arrow sit on the CI pill line, whatever is under it', async ({
      page,
    }) => {
      await expect
        .poll(async () =>
          (await measure(page)).flatMap((m) =>
            ['.repo', '.go']
              .filter(
                (n) =>
                  Math.abs(m.centres[n] - m.centres['.ci-pill']) > TOLERANCE,
              )
              .map(
                (n) =>
                  `${m.title}: ${n} centre ${m.centres[n]} vs CI pill ${m.centres['.ci-pill']}`,
              ),
          ),
        )
        .toEqual([]);
    });

    test('the page does not scroll sideways', async ({ page }) => {
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(over).toBeLessThanOrEqual(0);
    });
  });
}

test.describe('at 1000px and 200% root font', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = 'html { font-size: 200% !important; }';
      document.addEventListener('DOMContentLoaded', () =>
        document.head.appendChild(style),
      );
    });
    await open(page, 1000);
  });

  test('the CI pill is on the title centre line', async ({ page }) => {
    await expect
      .poll(async () =>
        (await measure(page))
          .filter((m) => /Clean|comment pill|waiting on CI/.test(m.title))
          .filter(
            (m) =>
              Math.abs(m.centres['.ci-pill'] - m.firstLineCentre) > TOLERANCE,
          )
          .map(
            (m) =>
              `${m.title}: CI pill ${m.centres['.ci-pill']} vs title ${m.firstLineCentre}`,
          ),
      )
      .toEqual([]);
  });

  test('nothing overflows or clips', async ({ page }) => {
    await expect
      .poll(() =>
        page.locator('#pr-rows > .row').evaluateAll((rows) =>
          rows.flatMap((r) => {
            const rb = r.getBoundingClientRect();
            return [
              ...r.querySelectorAll(
                '.ci-pill, .review-pill, .row-action, .title-text',
              ),
            ]
              .filter((e) => {
                const b = e.getBoundingClientRect();
                return (
                  b.width > 0 &&
                  (b.right > rb.right + 1 || b.left < rb.left - 1)
                );
              })
              .map(
                (e) =>
                  `${r.querySelector('.title-text')?.textContent}: ${e.className}`,
              );
          }),
        ),
      )
      .toEqual([]);
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

// The status area, with its fix button, is the note under the title from
// 1191px of list width, so Tab reaches Update branch before the pills that sit
// in the status cell. At 200% root font and on a phone the note stays in the
// status cell and the order is the old one (title, label, CI pill, comment
// pill, Update branch). Pinned so a change to either is a decision.
test.describe('keyboard order of a row with a fix button', () => {
  const order = (page: Page) =>
    page
      .locator('#pr-rows > .row', { hasText: 'behind with a comment' })
      .evaluate((r) =>
        [...r.querySelectorAll('a, button')].map((e) =>
          e.matches('.title')
            ? 'title'
            : e.matches('.ci-pill')
              ? 'ci'
              : e.matches('.review-pill')
                ? 'comments'
                : (e.textContent ?? '').trim(),
        ),
      );

  test('at 1280px Update branch comes before the CI and comment pills', async ({
    page,
  }) => {
    await open(page, 1280, [BEHIND]);
    await expect
      .poll(() => order(page))
      .toEqual(['title', 'Update branch', 'ci', 'comments']);
  });

  test('at 390px the pills come first and Update branch last', async ({
    page,
  }) => {
    await open(page, 390, [BEHIND]);
    await expect
      .poll(() => order(page))
      .toEqual(['title', 'ci', 'comments', 'Update branch']);
  });
});

for (const width of [1280, 1000, 390]) {
  test(`the rows have no axe violations at ${width}px`, async ({ page }) => {
    await open(page, width, [...PRS, BEHIND, BOTH]);
    const results = await new AxeBuilder({ page })
      .include('#pr-rows')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
