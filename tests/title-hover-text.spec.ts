import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A title cut with an ellipsis carries the whole title as hover text, on the
// visible text and only while it is cut. Mocks /api/dashboard only.
// https://github.com/alrayyes/forge-dashboard/issues/1695

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const LONG =
  'Rework the dashboard refresh pipeline so a slow forge never blocks the others and every retry backs off with jitter instead of hammering the API';
// The title column is 268px from 1280px up and narrower below: this title
// is cut at 1100px and whole at 1280px.
const MEDIUM = 'Fix the refresh back-off bug';
const HTML_LOOKING = `<b>x</b> ${LONG}`;

function makePR(number: number, title: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: ago(60),
    updatedAt: ago(5),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
  };
}

function makeIssue(number: number, title: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title,
    url: `https://example.com/issues/${number}`,
    author: 'ryankes',
    labels: [],
    createdAt: ago(60),
    updatedAt: ago(5),
  };
}

async function mockDashboard(
  page: Page,
  pullRequests: unknown[],
  issues: unknown[] = [],
) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues,
      }),
    }),
  );
}

const text = (page: Page, rows: string, n: number) =>
  page.locator(`${rows} .row`, { hasText: `#${n}` }).locator('.title-text');

test.describe('truncated titles show the whole title on hover', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockDashboard(
      page,
      [
        makePR(1, LONG),
        makePR(2, 'Short title'),
        makePR(3, HTML_LOOKING),
        makePR(4, MEDIUM),
      ],
      [makeIssue(11, LONG), makeIssue(12, 'Short issue')],
    );
  });

  test('a cut pull request title carries it, a short one does not', async ({
    page,
  }) => {
    await page.goto('/pull-requests.html');
    await expect(text(page, '#pr-rows', 1)).toBeVisible();
    await expect(text(page, '#pr-rows', 1)).toHaveAttribute('title', LONG);
    await expect(text(page, '#pr-rows', 2)).not.toHaveAttribute('title');
  });

  test('the hover text is the title as written, without the number', async ({
    page,
  }) => {
    await page.goto('/pull-requests.html');
    await expect(text(page, '#pr-rows', 1)).toHaveAttribute('title', /./);
    const title = await text(page, '#pr-rows', 1).getAttribute('title');
    expect(title).toBe(LONG);
    expect(title).not.toContain('#1');
  });

  test('widening the window removes it and narrowing adds it back', async ({
    page,
  }) => {
    await page.goto('/pull-requests.html');
    const medium = text(page, '#pr-rows', 4);
    // 1104 px is the narrowest window with the full row grid (#1899), so the
    // title column is as small as it gets there without the phone layout.
    await page.setViewportSize({ width: 1104, height: 800 });
    await expect(medium).toHaveAttribute('title', MEDIUM);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(medium).not.toHaveAttribute('title');
    await page.setViewportSize({ width: 1104, height: 800 });
    await expect(medium).toHaveAttribute('title', MEDIUM);
  });

  test('the cut text is what the pointer hits, and a click on it still opens the dialog', async ({
    page,
  }) => {
    await page.route('**/api/pull-requests/details*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          description: null,
          comments: [],
          commentCount: 0,
          commentsTruncated: false,
          releaseNotes: null,
        }),
      }),
    );
    await page.goto('/pull-requests.html');
    const span = text(page, '#pr-rows', 1);
    await expect(span).toHaveAttribute('title', LONG);
    const box = await span.boundingBox();
    if (!box) throw new Error('no title box');
    const y = box.y + box.height / 2;
    // A native tooltip comes from the element under the pointer and its
    // ancestors, so the stretched-link overlay must not sit on top of it.
    for (const x of [
      box.x + 40,
      box.x + box.width / 2,
      box.x + box.width - 4,
    ]) {
      const hit = await page.evaluate(
        ([px, py]) => {
          const el = document.elementFromPoint(px, py);
          return el?.closest('.title-text') ? 'text' : (el?.tagName ?? 'none');
        },
        [x, y],
      );
      expect(hit).toBe('text');
    }
    await page.mouse.click(box.x + box.width / 2, y);
    await expect(
      page.getByRole('dialog', { name: /^Pull request details/ }),
    ).toBeVisible();
  });

  test('the hover text is re-checked once the web fonts have loaded', async ({
    page,
  }) => {
    await page.goto('/pull-requests.html');
    const fits = text(page, '#pr-rows', 4);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(fits).not.toHaveAttribute('title');
    // Wider glyphs after the first measure, as a font swap would make them.
    await page.addStyleTag({
      content: '.title-text { letter-spacing: 6px !important; }',
    });
    await page.evaluate(() =>
      document.fonts.dispatchEvent(new Event('loadingdone')),
    );
    await expect(fits).toHaveAttribute('title', MEDIUM);
  });

  test('the row button keeps its name and gets no second description', async ({
    page,
  }) => {
    await page.goto('/pull-requests.html');
    const button = page
      .locator('#pr-rows .row', { hasText: '#1' })
      .getByRole('button', { name: /^#1 / });
    await expect(button).toHaveAccessibleName(`#1 ${LONG}`);
    await expect(button).not.toHaveAttribute('title');
    await expect(button).toHaveAccessibleDescription('');
  });

  test('HTML-looking text stays text', async ({ page }) => {
    await page.goto('/pull-requests.html');
    const span = text(page, '#pr-rows', 3);
    await expect(span).toHaveAttribute('title', HTML_LOOKING);
    await expect(span.locator('b')).toHaveCount(0);
  });

  test('issue rows get it too', async ({ page }) => {
    await page.goto('/issues.html');
    await expect(text(page, '#issue-rows', 11)).toHaveAttribute('title', LONG);
    await expect(text(page, '#issue-rows', 12)).not.toHaveAttribute('title');
  });

  test('at 360px nothing scrolls sideways and axe passes', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/pull-requests.html');
    await expect(text(page, '#pr-rows', 1)).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const scan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(scan.violations).toEqual([]);
  });
});
