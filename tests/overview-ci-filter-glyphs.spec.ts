import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The pull request overview's CI filter draws the same glyphs, tones and pressed
// treatment as the Main branches status filter, from the one shared component,
// so one shape means one state on every page (#4246).
// https://github.com/alrayyes/forge-dashboard/issues/4246
// https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html

const STATES = [
  { ci: 'failure', label: 'Failing', glyph: 'cross' },
  { ci: 'pending', label: 'Running', glyph: 'arc' },
  { ci: 'success', label: 'Passing', glyph: 'check' },
  { ci: 'none', label: 'No checks', glyph: 'slash' },
] as const;

function pr(number: number, ci: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci,
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
  };
}

async function open(
  page: Page,
  scheme: 'light' | 'dark' = 'light',
  width = 1280,
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 800 });
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
        pullRequests: STATES.map(({ ci }, i) => pr(i + 1, ci)),
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  if (width <= 760) {
    // The phone shows the pills in the Filters sheet.
    await page.getByRole('button', { name: /^Filters/ }).click();
  }
  await expect(visible(page, 'Failing')).toBeVisible();
}

// The bar and the phone sheet each hold a copy of the group; take the one
// that is showing.
const visible = (page: Page, label: string) =>
  page
    .locator('.quick-pills[data-group="ci"], .sheet-pills[data-group="ci"]')
    .getByRole('button', { name: label, exact: true })
    .and(page.locator(':visible'));

test('each CI filter pill shows its glyph before the word, and All does not', async ({
  page,
}) => {
  await open(page);
  for (const { label, glyph } of STATES) {
    const button = visible(page, label);
    const svgs = button.locator('svg.check-glyph');
    await expect(svgs.filter({ visible: true })).toHaveCount(1);
    await expect(button.locator(`svg[data-glyph="${glyph}"]`)).toHaveCount(1);
    await expect(svgs.first()).toHaveAttribute('aria-hidden', 'true');
    const firstChild = await button.evaluate(
      (b) => b.firstElementChild?.tagName,
    );
    expect(firstChild?.toLowerCase()).toBe('svg');
  }
  await expect(
    page
      .locator('.filter-bar .quick-pills[data-group="ci"] [data-pill="all"]')
      .locator('svg'),
  ).toHaveCount(0);
  await expect(
    page.locator('.filter-bar .quick-pills[data-group="forge"]').locator('svg'),
  ).toHaveCount(0);
});

test('the pill is still named by its word alone', async ({ page }) => {
  await open(page);
  for (const { label } of STATES) {
    await expect(
      page
        .locator('.filter-bar .quick-pills[data-group="ci"]')
        .getByRole('button', { name: label, exact: true }),
    ).toBeVisible();
  }
});

test('only the glyph is coloured until the pill is pressed', async ({
  page,
}) => {
  await open(page);
  const colours = await page
    .locator('.filter-bar .quick-pills[data-group="ci"] .ci-filter-pill')
    .evaluateAll((pills) =>
      pills.map((p) => ({
        glyph: getComputedStyle(p.querySelector('svg') as Element).color,
        word: getComputedStyle(p).color,
        bg: getComputedStyle(p).backgroundColor,
      })),
    );
  expect(colours).toHaveLength(4);
  for (const c of colours) {
    expect(c.word).toBe(colours[0].word);
    expect(c.bg).toBe(colours[0].bg);
  }
  expect(new Set(colours.map((c) => c.glyph)).size).toBe(4);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`a pressed Failing pill takes the critical pair and an inset ring, with no tick, in ${scheme}`, async ({
    page,
  }) => {
    await open(page, scheme);
    await visible(page, 'Failing').click();
    await expect(visible(page, 'Failing')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const got = await visible(page, 'Failing').evaluate((b) => {
      const probe = document.createElement('i');
      document.body.append(probe);
      const resolved = (v: string) => {
        probe.style.color = `var(${v})`;

        return getComputedStyle(probe).color;
      };
      const s = getComputedStyle(b);
      const out = {
        critical: resolved('--critical'),
        criticalBg: resolved('--critical-bg'),
        color: s.color,
        bg: s.backgroundColor,
        shadow: s.boxShadow,
        tick: getComputedStyle(b, '::before').content,
      };
      probe.remove();

      return out;
    });
    expect(got.bg).toBe(got.criticalBg);
    expect(got.color).toBe(got.critical);
    expect(got.shadow).toContain('inset');
    expect(got.shadow).toContain(got.critical);
    // The glyph and the ring carry the pick, so the tick goes.
    expect(['none', 'normal']).toContain(got.tick);
  });
}

test('All keeps the accent fill and its tickless look when pressed', async ({
  page,
}) => {
  await open(page);
  await visible(page, 'Failing').click();
  await page
    .locator('.filter-bar .quick-pills[data-group="ci"]')
    .getByRole('button', { name: 'All', exact: true })
    .click();
  const all = page
    .locator('.filter-bar .quick-pills[data-group="ci"]')
    .getByRole('button', { name: 'All', exact: true });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  const bg = await all.evaluate((b) => getComputedStyle(b).backgroundColor);
  const accent = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--accent)';
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();

    return c;
  });
  expect(bg).toBe(accent);
});

test('the Running glyph spins, and under reduced motion shows a still clock', async ({
  page,
}) => {
  await open(page);
  const running = visible(page, 'Running');
  const read = () =>
    running.evaluate((b) => {
      const style = (name: string) =>
        getComputedStyle(b.querySelector(`.check-glyph-${name}`) as Element);
      return {
        arc: style('arc').display,
        clock: style('clock').display,
        spin: style('arc').animationName,
      };
    });
  expect(await read()).toEqual({
    arc: 'block',
    clock: 'none',
    spin: 'check-spin',
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await read();
  expect(still.arc).toBe('none');
  expect(still.clock).toBe('block');
  await expect(running.locator('svg[data-glyph="clock"]')).toBeVisible();
});

test('pressing a pill does not change its width', async ({ page }) => {
  await open(page);
  const group = page.locator('.filter-bar .quick-pills[data-group="ci"]');
  const widths = () =>
    group
      .locator('.ci-filter-pill')
      .evaluateAll((ps) => ps.map((p) => p.getBoundingClientRect().width));
  const before = await widths();
  for (const { label } of STATES) {
    await visible(page, label).click();
    expect(await widths(), `${label} pressed`).toEqual(before);
  }
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test(`the CI filter passes axe, does not overflow and keeps its targets in ${scheme} at ${width}px`, async ({
      page,
    }) => {
      await open(page, scheme, width);
      await visible(page, 'Running').click();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);

      const layout = await page.evaluate(() => {
        const el = document.documentElement;
        const heights = [...document.querySelectorAll('.ci-filter-pill')]
          .filter((p) => (p as HTMLElement).offsetParent !== null)
          .map((p) => p.getBoundingClientRect().height);

        return { scrolls: el.scrollWidth > el.clientWidth, heights };
      });
      expect(layout.scrolls).toBe(false);
      expect(layout.heights.length).toBeGreaterThan(0);
      if (width <= 760) {
        expect(Math.min(...layout.heights)).toBeGreaterThanOrEqual(44);
      }
    });
  }
}

test('a state with no pull request is not offered, and its glyph is not either', async ({
  page,
}) => {
  await open(page);
  await page.unroute('**/api/v1/dashboard*');
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [pr(1, 'success'), pr(2, 'failure')],
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  const group = page.locator('.filter-bar .quick-pills[data-group="ci"]');
  await expect(
    group.getByRole('button', { name: 'Failing', exact: true }),
  ).toBeVisible();
  await expect(group.locator('[data-pill="no-checks"]')).toBeHidden();
  await expect(group.locator('svg[data-glyph="slash"]')).toBeHidden();
});
