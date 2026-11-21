import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A Failed row has the most pills of any state: the word, up to five counts,
// the comment pill and the action. From a 1191px list the status cell is three
// fixed slots, and the CI slot was a fixed 10.25rem, so a pill with three or
// more counts ran 10 to 70px into the comment slot and the comment pill sat on
// top of its last count (#4541). No pill's box may cross another's, in any
// state with the comment pill, down to the narrow layouts.
// https://github.com/alrayyes/forge-dashboard/issues/4541

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'example-org/api-gateway',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'demo-user',
    draft: false,
    ci: 'failure',
    checks: { passed: 19, skipped: 12, running: 1, waiting: 0, failed: 1 },
    labels: [],
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    reviewComments: 123,
    unresolvedThreads: 2,
    ...overrides,
  };
}

const ROWS: Record<string, ReturnType<typeof pr>> = {
  'Failed with four counts and a 3-digit comment pill': pr(1),
  'Failed with five counts and a 3-digit comment pill': pr(2, {
    checks: { passed: 140, skipped: 12, running: 2, waiting: 3, failed: 11 },
  }),
  'Failed with two counts and a comment pill': pr(3, {
    checks: { passed: 8, running: 0, waiting: 0, failed: 3 },
    reviewComments: 5,
  }),
  'Failed with four counts and a conflict': pr(4, {
    mergeStatus: 'conflicting',
    conflictConfirmed: true,
    reviewComments: 0,
    unresolvedThreads: 0,
  }),
};

async function open(page: Page, width: number, prs: unknown[]) {
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

// Every pill and the action button on a row, as boxes, once the row settles.
async function boxes(page: Page) {
  return page.locator('#pr-rows > .row').evaluateAll((rows) =>
    rows.map((r) => {
      const out: Record<string, number[]> = {};
      for (const sel of [
        '.ci-pill',
        '.ci-seg-failed',
        '.review-pill',
        '.merge-pill',
        '.row-action',
      ]) {
        r.querySelectorAll(sel).forEach((e, i) => {
          const b = e.getBoundingClientRect();
          if (b.width > 0)
            out[`${sel}#${i}`] = [b.left, b.top, b.right, b.bottom];
        });
      }
      return { title: r.querySelector('.title-text')?.textContent ?? '', out };
    }),
  );
}

// Two boxes cross when they share area; touching edges do not count.
function crossing(a: number[], b: number[]) {
  return (
    a[0] < b[2] - 0.5 &&
    b[0] < a[2] - 0.5 &&
    a[1] < b[3] - 0.5 &&
    b[1] < a[3] - 0.5
  );
}

for (const width of [1440, 1280, 1186, 1124, 1000, 800]) {
  test(`no pill crosses another on a failed row at ${width}px`, async ({
    page,
  }) => {
    await open(page, width, Object.values(ROWS));
    await expect
      .poll(async () => {
        const found: string[] = [];
        for (const row of await boxes(page)) {
          const names = Object.keys(row.out).filter(
            // The count lives inside the CI pill, so the two overlap by design.
            (n) => !n.startsWith('.ci-seg-failed'),
          );
          for (const [i, a] of names.entries()) {
            for (const b of names.slice(i + 1)) {
              if (crossing(row.out[a], row.out[b])) {
                found.push(`${row.title}: ${a} crosses ${b}`);
              }
            }
          }
          const failed = row.out['.ci-seg-failed#0'];
          for (const n of names.filter((x) => !x.startsWith('.ci-pill'))) {
            if (failed && crossing(failed, row.out[n])) {
              found.push(`${row.title}: the failed count is under ${n}`);
            }
          }
        }
        return found;
      })
      .toEqual([]);
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scroll).toBeLessThanOrEqual(client);
  });
}

test('a row whose pill fits keeps the status track it had at 1280px', async ({
  page,
}) => {
  await open(page, 1280, Object.values(ROWS));
  const widths = await page
    .locator('#pr-rows > .row .status-cell')
    .evaluateAll((cells) => cells.map((c) => c.getBoundingClientRect().width));
  // 27.5rem at a 16px root; the two counts row is the one that fits.
  expect(widths[2]).toBe(440);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`failed rows have no axe violations in ${scheme} at 1280px`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, 1280, Object.values(ROWS));
    const results = await new AxeBuilder({ page })
      .include('#pr-rows')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
