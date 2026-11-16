import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3829
//
// The Created and Updated columns on the Issues and Pull requests lists sat in
// tracks sized in px while their text follows the root font size, so at 200%
// the two columns' text ran into each other at 1280px.

const ago = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString();

async function routeDashboard(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/app',
            number: 1,
            title:
              'Keep the date columns apart when the title is long enough that it needs several lines at this width',
            url: 'https://example.test/alrayyes/app/pull/1',
            author: 'claude',
            draft: false,
            ci: 'success',
            checks: { passed: 4, running: 0, waiting: 0, failed: 0 },
            labels: [{ name: 'bug', color: 'd73a4a' }],
            createdAt: ago(3 * 86400),
            updatedAt: ago(100),
            mergeStatus: 'mergeable',
          },
        ],
        issues: [
          {
            forge: 'github',
            repo: 'alrayyes/app',
            number: 9,
            title:
              'Keep the date columns apart when the title is long enough that it needs several lines at this width',
            url: 'https://example.test/alrayyes/app/issues/9',
            author: 'claude',
            labels: [{ name: 'bug', color: 'd73a4a' }],
            createdAt: ago(3 * 86400),
            updatedAt: ago(100),
          },
        ],
        openIssueCount: 1,
        repos: [],
        hiddenDrafts: 0,
        firstRefreshDone: true,
      }),
    }),
  );
}

type Rect = { left: number; right: number; top: number; bottom: number };

// The painted extent of a cell: its box and everything its text draws, so text
// spilling out of a too-narrow track counts.
async function extents(page: Page, rows: string) {
  return page.evaluate((sel) => {
    const row = document.querySelector(`${sel} > .row`) as HTMLElement;
    const extent = (cls: string) => {
      const cell = row.querySelector(cls) as HTMLElement;
      const box = cell.getBoundingClientRect();
      let left = box.left;
      let right = box.right;
      let top = box.top;
      let bottom = box.bottom;
      const range = document.createRange();
      range.selectNodeContents(cell);
      for (const r of Array.from(range.getClientRects())) {
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      return { left, right, top, bottom };
    };
    return {
      created: extent('.created'),
      updated: extent('.updated'),
      boxes: ['.created', '.updated'].map((c) => {
        const r = (row.querySelector(c) as HTMLElement).getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      }),
    };
  }, rows);
}

const intersects = (a: Rect, b: Rect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// The computed grid-template-columns on main, per viewport width, at 100%.
// The 1280 values are asserted exactly. Below that the last track is `auto`
// and sized by a text arrow, so only the track count and total are asserted,
// plus a bound on the arrow track; the split here is one font's.
const TRACKS_100: Record<string, Record<string, string>> = {
  '#issue-rows': {
    '320': '218px 16px',
    '390': '288px 16px',
    '1280': '280px 560px 96px 82px 82px 22px',
  },
  '#pr-rows': {
    '320': '218px 16px',
    '390': '288px 16px',
    '1280': '280px 268px 96px 82px 82px 280px 22px',
  },
};

const LISTS = [
  ['Issues', '/issues.html', '#issue-rows'],
  ['Pull requests', '/pull-requests.html', '#pr-rows'],
] as const;

async function open(
  page: Page,
  path: string,
  rows: string,
  percent: number,
  width = 1280,
) {
  await page.setViewportSize({ width, height: 800 });
  await routeDashboard(page);
  await page.goto(path);
  await expect(page.locator(`${rows} > .row`).first()).toBeVisible();
  if (percent !== 100) {
    await page.addStyleTag({
      content: `html { font-size: ${percent}% !important; }`,
    });
  }
}

for (const [name, path, rows] of LISTS) {
  test(`${name}: Created and Updated stay apart at 200% and 1280px`, async ({
    page,
  }) => {
    await open(page, path, rows, 200);
    await expect
      .poll(async () => {
        const e = await extents(page, rows);
        // The text spilling out of its track is what made the columns touch
        // (right edge == left edge), so a gap has to be left, not just no
        // overlap.
        return (
          intersects(e.created, e.updated) ||
          e.created.right > e.boxes[0].right + 0.5 ||
          e.updated.right > e.boxes[1].right + 0.5 ||
          e.updated.left - e.created.right < 4
        );
      })
      .toBe(false);
  });

  // At 400% the list is about 19rem wide: the date columns cannot sit beside a
  // readable title, so the row drops them, as it already does between 761px
  // and 1103px.
  test(`${name}: at 400% and 1280px the date columns are dropped`, async ({
    page,
  }) => {
    await open(page, path, rows, 400);
    await expect(page.locator(`${rows} > .row .created`).first()).toBeHidden();
    await expect(page.locator(`${rows} > .row .updated`).first()).toBeHidden();
  });

  for (const [percent, width] of [
    [200, 1104],
    [200, 1200],
    [200, 1280],
    [200, 1300],
    [400, 1104],
    [400, 1280],
  ] as const) {
    test(`${name}: a long title stays readable and the row stays inside the page at ${percent}% and ${width}px`, async ({
      page,
    }) => {
      await open(page, path, rows, percent, width);
      const measure = () =>
        page.evaluate((sel) => {
          const row = document.querySelector(`${sel} > .row`) as HTMLElement;
          const title = row.querySelector('.title-cell') as HTMLElement;
          return {
            title: title.getBoundingClientRect().width,
            scroll: row.scrollWidth,
            client: row.clientWidth,
            height: row.getBoundingClientRect().height,
          };
        }, rows);
      // Re-measure until the row has settled, so one read under load can't
      // fail it.
      await expect
        .poll(async () => {
          const m = await measure();
          return [
            ['title width under 200px', m.title >= 200],
            ['row scrolls sideways', m.scroll <= m.client],
            // A title squeezed to a few pixels stacks one letter per line.
            ['row height 400px or more', m.height < 400],
          ]
            .filter(([, ok]) => !ok)
            .map(([what]) => `${what} (${JSON.stringify(m)})`);
        })
        .toEqual([]);
    });
  }

  // The compact layout has to win the cascade, not just hide the cells: the
  // created and updated tracks must be gone too, or the title stays narrow.
  test(`${name}: at 400% the grid uses the compact tracks`, async ({
    page,
  }) => {
    for (const width of [1104, 1280]) {
      await open(page, path, rows, 400, width);
      await expect
        .poll(
          () =>
            page.evaluate(
              (sel) =>
                getComputedStyle(
                  document.querySelector(`${sel} > .row`) as Element,
                ).gridTemplateColumns.split(' ').length,
              rows,
            ),
          { message: `${width}px track count` },
        )
        .toBe(rows === '#pr-rows' ? 4 : 3);
    }
  });

  test(`${name}: the grid tracks are unchanged at 100%`, async ({ page }) => {
    const read = () =>
      page.evaluate(
        (sel) =>
          getComputedStyle(document.querySelector(`${sel} > .row`) as Element)
            .gridTemplateColumns,
        rows,
      );
    // At 1280 every track is a fixed width, so pin them exactly. Below that the
    // last track is `auto` and holds a text arrow, so its width (and the split
    // with the 1fr track) follows the fallback font. Pin the track count, the
    // total and a bound on the arrow track, which is what the layout controls.
    const px = (tracks: string) => tracks.split(' ').map(parseFloat);
    const sum = (n: number[]) => n.reduce((a, b) => a + b, 0);
    for (const width of [320, 390, 1280]) {
      await open(page, path, rows, 100, width);
      await expect
        .poll(
          async () => {
            const tracks = await read();
            if (width === 1280) {
              return tracks === TRACKS_100[rows]['1280']
                ? 'ok'
                : `${tracks} != ${TRACKS_100[rows]['1280']}`;
            }
            const want = px(TRACKS_100[rows][width]);
            const have = px(tracks);
            const ok =
              have.length === want.length &&
              // The arrow track stays glyph-sized: roomy for any fallback font,
              // but it can't collapse or grow into a real column.
              have[1] >= 8 &&
              have[1] <= 24 &&
              Math.abs(sum(have) - sum(want)) < 0.05;
            // The measured tracks name what failed, as the old assertions did.
            return ok ? 'ok' : `${tracks} vs ${TRACKS_100[rows][width]}`;
          },
          { message: `${width}px tracks` },
        )
        .toBe('ok');
    }
  });

  for (const mode of ['light', 'dark', 'forced-colors'] as const) {
    test(`${name}: axe finds nothing at 200% in ${mode}`, async ({ page }) => {
      if (mode === 'forced-colors') {
        await page.emulateMedia({ forcedColors: 'active' });
      } else {
        await page.emulateMedia({ colorScheme: mode });
      }
      await open(page, path, rows, 200);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
