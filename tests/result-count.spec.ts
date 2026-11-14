import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { toggleLabels } from './label-filter-helper';
import { test } from './server-fixture';

// The row count on a list page is a result total, so the number is set in the
// main ink at 20px semibold and the rest of the line stays secondary (#3867).
// https://github.com/alrayyes/forge-dashboard/issues/3867

const NOW = new Date().toISOString();

const pr = (number: number, label: string) => ({
  forge: 'github',
  repo: 'acme/app',
  number,
  title: `Pull request ${number}`,
  url: `https://example.com/pull/${number}`,
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [{ name: label, color: 'ededed' }],
  createdAt: NOW,
  updatedAt: NOW,
  mergeStatus: 'mergeable',
});

const issue = (number: number) => ({
  forge: 'github',
  repo: 'acme/app',
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryan',
  labels: [],
  createdAt: NOW,
  updatedAt: NOW,
});

const PRS = [pr(1, 'bug'), pr(2, 'bug'), pr(3, 'docs'), pr(4, 'docs')];
const ISSUES = [issue(1), issue(2), issue(3)];

async function open(page: Page, url: string) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(url);
}

function lum([r, g, b]: number[]) {
  const [x, y, z] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * x + 0.7152 * y + 0.0722 * z;
}

// Contrast of the number and of the sentence against the first opaque
// background above the count. Read through expect.poll by the callers, so a
// style that settles a frame late doesn't flake.
async function ratios(page: Page, id: string) {
  const rgb = (v: string) => v.match(/[\d.]+/g)?.map(Number) ?? [];
  const read = await page.locator(`#${id}`).evaluate((el) => {
    let bg = '';
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (!/rgba\(.*, 0\)$|transparent/.test(c)) {
        bg = c;
        break;
      }
    }
    return {
      bg,
      number: getComputedStyle(el.querySelector('strong') as Element).color,
      rest: getComputedStyle(el).color,
    };
  });
  const ratio = (fg: string) => {
    const [hi, lo] = [lum(rgb(fg)), lum(rgb(read.bg))].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };
  return { number: ratio(read.number), rest: ratio(read.rest) };
}

// --ink in each theme, as the browser computes it.
const INK = { light: 'rgb(16, 24, 38)', dark: 'rgb(231, 235, 241)' } as const;

// 1.25rem at the default root size, semibold, in the main ink.
async function expectEmphasised(
  page: Page,
  id: string,
  scheme: 'light' | 'dark' = 'light',
) {
  const number = page.locator(`#${id} strong`);
  await expect(number).toHaveCSS('font-size', '20px');
  await expect(number).toHaveCSS('font-weight', '600');
  await expect(number).toHaveCSS('color', INK[scheme]);
}

async function expectContrast(page: Page, id: string) {
  await expect
    .poll(async () => {
      const r = await ratios(page, id);
      return Math.min(r.number, r.rest) >= 4.5;
    })
    .toBe(true);
  const results = await new AxeBuilder({ page })
    .withRules(['color-contrast'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('result count prominence (#3867)', () => {
  test('pull requests: "4 open" with the 4 at 18px+, weight 600+, in --ink', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    const count = page.locator('#pr-count');
    await expect(count).toHaveText('4 open');
    await expect(count.locator('strong')).toHaveText('4');
    await expectEmphasised(page, 'pr-count');
    await expectContrast(page, 'pr-count');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`a filter that leaves two of four reads "Showing 2 of 4" with the 2 emphasised, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, '/pull-requests.html');
      await expect(page.locator('#pr-count')).toHaveText('4 open');
      await toggleLabels(page, 'bug');
      const count = page.locator('#pr-count');
      await expect(count).toHaveText('Showing 2 of 4');
      await expect(count.locator('strong')).toHaveText('2');
      await expectEmphasised(page, 'pr-count', scheme);
      await expectContrast(page, 'pr-count');
    });
  }

  test('issues: the same style on #issue-count', async ({ page }) => {
    await open(page, '/issues.html');
    await expect(page.locator('#issue-count')).toHaveText('3 open');
    await expectEmphasised(page, 'issue-count');
  });

  // These shrink the layout width to what a 390px phone has at that zoom
  // (390 / zoom CSS pixels); they don't scale the root font size.
  for (const zoom of [1, 1.5, 1.75]) {
    test(`phone 390px at ${zoom * 100}% (layout width ${Math.round(390 / zoom)}px): count visible, no sideways scroll`, async ({
      page,
    }) => {
      const width = Math.round(390 / zoom);
      await page.setViewportSize({ width, height: 800 });
      await open(page, '/pull-requests.html');
      await expect(page.locator('#pr-count')).toBeVisible();
      await expect(page.locator('#pr-count')).toHaveText('4 open');
      await expect(page.locator('dialog#filter-sheet')).toBeHidden();
      const box = await page.locator('#pr-count').boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
    });
  }

  // A real root font scale: the count's em-based size follows it, and the
  // header still doesn't scroll sideways.
  test('with the root font at 175% the number scales and the page holds', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, '/pull-requests.html');
    await expect(page.locator('#pr-count')).toHaveText('4 open');
    await page.addStyleTag({ content: 'html { font-size: 175%; }' });
    await expect(page.locator('#pr-count strong')).toHaveCSS(
      'font-size',
      '35px',
    );
    await expect(page.locator('#pr-count')).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test('820px: the count sits in the header on one line', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 800 });
    await open(page, '/pull-requests.html');
    const count = page.locator('#pr-count');
    await expect(count).toHaveText('4 open');
    const box = await count.boundingBox();
    const head = await page.locator('.board-head').boundingBox();
    expect(box?.height).toBeLessThan(40);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (head?.x ?? 0) + (head?.width ?? 0),
    );
  });

  test('forced colors: the number stays semibold and visible', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, '/pull-requests.html');
    await expect(page.locator('#pr-count')).toHaveText('4 open');
    await expect(page.locator('#pr-count strong')).toBeVisible();
    await expect(page.locator('#pr-count strong')).toHaveCSS(
      'font-weight',
      '600',
    );
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the count is 4.5:1 in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, '/pull-requests.html');
      await expect(page.locator('#pr-count')).toHaveText('4 open');
      await expectContrast(page, 'pr-count');
    });
  }

  test('the count is not a live region; the status region says the count once', async ({
    page,
  }) => {
    await open(page, '/pull-requests.html');
    const count = page.locator('#pr-count');
    await expect(count).toHaveText('4 open');
    expect(
      await count.evaluate((el) =>
        el.closest('[aria-live], [role="status"], [role="alert"]'),
      ),
    ).toBeNull();
    const live = page.locator('#shared-label-filter [role="status"]').first();
    await toggleLabels(page, 'bug');
    await expect(live).toHaveText('2 pull requests');
    await expect(count).toHaveText('Showing 2 of 4');
  });
});
