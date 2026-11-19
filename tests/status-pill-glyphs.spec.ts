import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The status filter on the Main branches page draws the same glyphs and colours
// as the CI pills in its rows, so the filter reads as the key to them and a
// failing branch differs from a passing one by shape as well as colour (#4221).
// https://github.com/alrayyes/forge-dashboard/issues/4221
// https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html

const STATUSES = [
  { key: 'failed', label: 'Failing', glyph: 'cross' },
  { key: 'passed', label: 'Passing', glyph: 'check' },
  { key: 'running', label: 'Running', glyph: 'arc' },
  { key: 'cancelled', label: 'Cancelled', glyph: 'stop' },
  { key: 'awaiting_approval', label: 'Waiting for approval', glyph: 'pause' },
  { key: 'unknown', label: 'Unknown', glyph: 'question' },
  { key: 'none', label: 'No pipeline', glyph: 'slash' },
] as const;

async function seed(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [],
        issues: [],
        repos: [{ forge: 'github', fullName: 'acme/a', hasWebhook: true }],
        firstRefreshDone: true,
      }),
    }),
  );
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {},
        branches: STATUSES.map(({ key }, i) => ({
          forge: 'github',
          fullName: `acme/r${i}`,
          url: `https://example.com/acme/r${i}`,
          branch: 'main',
          status: key,
          commit:
            key === 'none'
              ? null
              : {
                  sha: 'd98f3c2',
                  subject: 'fix: a change',
                  author: 'dev',
                  committedAt: new Date(Date.now() - i * 60_000).toISOString(),
                },
          failingJobs: key === 'failed' ? ['lint'] : [],
          finishedAt: new Date().toISOString(),
          durationSeconds: 60,
          runUrl: `https://example.com/acme/r${i}/actions/runs/1`,
          staleSince: null,
        })),
      }),
    }),
  );
}

const statusGroup = (page: Page) =>
  page.getByRole('group', { name: 'Filter by status' });
const pill = (page: Page, label: string) =>
  statusGroup(page).getByRole('button', { name: new RegExp(`^${label} \\d`) });

async function open(
  page: Page,
  scheme: 'light' | 'dark' = 'light',
  width = 1280,
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 800 });
  await seed(page);
  await page.goto('/');
  await expect(pill(page, 'Failing')).toBeVisible();
}

test('each status pill shows its glyph before the word, and nothing else does', async ({
  page,
}) => {
  await open(page);
  await expect(statusGroup(page).locator('.mb-pill')).toHaveCount(8);
  for (const { label, glyph } of STATUSES) {
    const button = pill(page, label);
    const svgs = button.locator('svg.check-glyph');
    await expect(svgs.filter({ visible: true })).toHaveCount(1);
    await expect(button.locator(`svg[data-glyph="${glyph}"]`)).toHaveCount(1);
    await expect(svgs.first()).toHaveAttribute('aria-hidden', 'true');
    // The glyph comes first, then the word and the count.
    const firstChild = await button.evaluate(
      (b) => b.firstElementChild?.tagName,
    );
    expect(firstChild?.toLowerCase()).toBe('svg');
  }
  await expect(pill(page, 'All').locator('svg')).toHaveCount(0);
  await expect(
    page.getByRole('group', { name: 'Filter by forge' }).locator('svg'),
  ).toHaveCount(0);
});

test('the button is named by its word and count, not by the glyph', async ({
  page,
}) => {
  await open(page);
  await expect(
    statusGroup(page).getByRole('button', { name: 'Failing 1', exact: true }),
  ).toBeVisible();
});

test('only the glyph is coloured until the pill is pressed', async ({
  page,
}) => {
  await open(page);
  const colours = await statusGroup(page)
    .locator('.mb-pill[data-status]')
    .evaluateAll((pills) =>
      pills.map((p) => ({
        status: p.getAttribute('data-status'),
        glyph: getComputedStyle(p.querySelector('svg') as Element).color,
        word: getComputedStyle(p).color,
        bg: getComputedStyle(p).backgroundColor,
      })),
    );
  expect(colours).toHaveLength(7);
  const [first] = colours;
  for (const c of colours) {
    expect(c.word, c.status ?? '').toBe(first.word);
    expect(c.bg, c.status ?? '').toBe(first.bg);
  }
  const glyphOf = (s: string) => colours.find((c) => c.status === s)?.glyph;
  expect(new Set(colours.map((c) => c.glyph)).size).toBeGreaterThan(3);
  expect(glyphOf('cancelled')).toBe(glyphOf('unknown'));
  expect(glyphOf('none')).toBe(glyphOf('unknown'));
  expect(glyphOf('running')).toBe(glyphOf('awaiting_approval'));
  expect(glyphOf('failed')).not.toBe(glyphOf('passed'));
});

for (const scheme of ['light', 'dark'] as const) {
  test(`a pressed Failing pill takes the critical pair and an inset ring in ${scheme}`, async ({
    page,
  }) => {
    await open(page, scheme);
    await pill(page, 'Failing').click();
    await expect(pill(page, 'Failing')).toHaveAttribute('aria-pressed', 'true');
    const styles = await statusGroup(page)
      .locator('.mb-pill[data-status]')
      .evaluateAll((pills) => {
        const probe = document.createElement('i');
        document.body.append(probe);
        const resolved = (v: string) => {
          probe.style.color = `var(${v})`;

          return getComputedStyle(probe).color;
        };
        const out = {
          critical: resolved('--critical'),
          criticalBg: resolved('--critical-bg'),
          pills: pills.map((p) => ({
            status: p.getAttribute('data-status'),
            color: getComputedStyle(p).color,
            bg: getComputedStyle(p).backgroundColor,
            shadow: getComputedStyle(p).boxShadow,
          })),
        };
        probe.remove();

        return out;
      });
    const failing = styles.pills.find((p) => p.status === 'failed');
    expect(failing?.bg).toBe(styles.criticalBg);
    expect(failing?.color).toBe(styles.critical);
    expect(failing?.shadow).toContain('inset');
    expect(failing?.shadow).toContain(styles.critical);
    for (const other of styles.pills.filter((p) => p.status !== 'failed')) {
      expect(other.bg, other.status ?? '').not.toBe(styles.criticalBg);
      expect(other.shadow, other.status ?? '').toBe('none');
    }
  });
}

test('All keeps the teal fill when pressed', async ({ page }) => {
  await open(page);
  await pill(page, 'All').click();
  const bg = await pill(page, 'All').evaluate(
    (b) => getComputedStyle(b).backgroundColor,
  );
  const teal = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--pill-active)';
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();

    return c;
  });
  expect(bg).toBe(teal);
});

test('the Running glyph spins, and under reduced motion shows a still clock', async ({
  page,
}) => {
  await open(page);
  const running = pill(page, 'Running');
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
  await expect(running.locator('svg[data-glyph="arc"]')).toBeHidden();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`a pressed pill shows the outer focus ring and the inner ring together in ${scheme}`, async ({
    page,
  }) => {
    await open(page, scheme);
    await pill(page, 'Failing').click();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const failing = pill(page, 'Failing');
    await expect(failing).toBeFocused();
    const ring = await failing.evaluate((b) => {
      const s = getComputedStyle(b);
      return {
        outline: s.outlineStyle,
        width: Number.parseFloat(s.outlineWidth),
        offset: Number.parseFloat(s.outlineOffset),
        shadow: s.boxShadow,
      };
    });
    expect(ring.outline).toBe('solid');
    expect(ring.width).toBeGreaterThanOrEqual(2);
    expect(ring.offset).toBeGreaterThan(0);
    expect(ring.shadow).toContain('inset');
  });
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test(`the filter bar passes axe and keeps its layout in ${scheme} at ${width}px`, async ({
      page,
    }) => {
      await open(page, scheme, width);
      await pill(page, 'Running').click();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);

      const layout = await page.evaluate(() => {
        const bar = document.querySelector('.mb-bar') as HTMLElement;
        const group = document.querySelector('.mb-group') as HTMLElement;
        const el = document.documentElement;

        return {
          scrolls: el.scrollWidth > el.clientWidth,
          barDirection: getComputedStyle(bar).flexDirection,
          groupWrap: getComputedStyle(group).flexWrap,
          heights: [...document.querySelectorAll('.mb-pill')].map(
            (p) => p.getBoundingClientRect().height,
          ),
        };
      });
      expect(layout.scrolls).toBe(false);
      expect(layout.groupWrap).toBe('wrap');
      expect(layout.barDirection).toBe(width <= 420 ? 'column' : 'row');
      const smallest = Math.min(...layout.heights);
      expect(smallest).toBeGreaterThanOrEqual(width <= 760 ? 44 : 24);
    });
  }
}

test('pills are 44px tall at 760px and 420px wide', async ({ page }) => {
  for (const width of [760, 421, 420]) {
    await open(page, 'light', width);
    const heights = await page
      .locator('.mb-pill')
      .evaluateAll((ps) => ps.map((p) => p.getBoundingClientRect().height));
    expect(Math.min(...heights), `${width}px`).toBeGreaterThanOrEqual(44);
  }
});

test('pressing a pill does not change its width', async ({ page }) => {
  await open(page);
  const widths = () =>
    statusGroup(page)
      .locator('.mb-pill')
      .evaluateAll((ps) => ps.map((p) => p.getBoundingClientRect().width));
  const before = await widths();
  for (const { label } of STATUSES) {
    await pill(page, label).click();
    expect(await widths(), `${label} pressed`).toEqual(before);
  }
});
