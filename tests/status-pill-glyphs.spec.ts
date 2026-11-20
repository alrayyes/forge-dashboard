import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { laidOutWidths, widthJumpsWhile } from './pill-width-helper';
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
  const readColours = () =>
    statusGroup(page)
      .locator('.mb-pill[data-status]')
      .evaluateAll((pills) =>
        pills.map((p) => ({
          status: p.getAttribute('data-status'),
          glyph: getComputedStyle(p.querySelector('svg') as Element).color,
          word: getComputedStyle(p).color,
          bg: getComputedStyle(p).backgroundColor,
        })),
      );
  // Retries until every pill is painted, so one unstyled read can't decide it.
  await expect
    .poll(async () => {
      const colours = await readColours();
      const [first] = colours;
      const glyphOf = (s: string) => colours.find((c) => c.status === s)?.glyph;
      return {
        count: colours.length,
        sameWord: colours.every((c) => c.word === first.word),
        sameBg: colours.every((c) => c.bg === first.bg),
        manyGlyphs: new Set(colours.map((c) => c.glyph)).size > 3,
        neutralShared:
          glyphOf('cancelled') === glyphOf('unknown') &&
          glyphOf('none') === glyphOf('unknown'),
        activeShared: glyphOf('running') === glyphOf('awaiting_approval'),
        failedApart: glyphOf('failed') !== glyphOf('passed'),
      };
    })
    .toEqual({
      count: 7,
      sameWord: true,
      sameBg: true,
      manyGlyphs: true,
      neutralShared: true,
      activeShared: true,
      failedApart: true,
    });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`a pressed Failing pill takes the critical pair and an inset ring in ${scheme}`, async ({
    page,
  }) => {
    await open(page, scheme);
    await pill(page, 'Failing').click();
    await expect(pill(page, 'Failing')).toHaveAttribute('aria-pressed', 'true');
    const read = () =>
      statusGroup(page)
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
    // Retries until the pressed pill is painted and the others have let go.
    await expect
      .poll(async () => {
        const styles = await read();
        const failing = styles.pills.find((p) => p.status === 'failed');
        const others = styles.pills.filter((p) => p.status !== 'failed');
        return {
          bg: failing?.bg === styles.criticalBg,
          color: failing?.color === styles.critical,
          ring:
            !!failing?.shadow.includes('inset') &&
            failing.shadow.includes(styles.critical),
          othersQuiet: others.every(
            (o) => o.bg !== styles.criticalBg && o.shadow === 'none',
          ),
        };
      })
      .toEqual({ bg: true, color: true, ring: true, othersQuiet: true });
  });
}

test('All keeps the teal fill when pressed', async ({ page }) => {
  await open(page);
  await pill(page, 'All').click();
  const teal = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--pill-active)';
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();

    return c;
  });
  await expect(pill(page, 'All')).toHaveCSS('background-color', teal);
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
  await expect.poll(read).toEqual({
    arc: 'block',
    clock: 'none',
    spin: 'check-spin',
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(async () => {
      const still = await read();
      return { arc: still.arc, clock: still.clock };
    })
    .toEqual({ arc: 'none', clock: 'block' });
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
    // Retries until both rings are painted; the focus ring can lag the focus.
    await expect
      .poll(() =>
        failing.evaluate((b) => {
          const s = getComputedStyle(b);
          return {
            outline: s.outlineStyle,
            wide: Number.parseFloat(s.outlineWidth) >= 2,
            offset: Number.parseFloat(s.outlineOffset) > 0,
            inner: s.boxShadow.includes('inset'),
          };
        }),
      )
      .toEqual({ outline: 'solid', wide: true, offset: true, inner: true });
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

      const layout = () =>
        page.evaluate(() => {
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
      // Retries until the bar has laid out at this width.
      await expect
        .poll(async () => {
          const now = await layout();
          return {
            scrolls: now.scrolls,
            groupWrap: now.groupWrap,
            barDirection: now.barDirection,
            tall: Math.min(...now.heights) >= (width <= 760 ? 44 : 24),
          };
        })
        .toEqual({
          scrolls: false,
          groupWrap: 'wrap',
          barDirection: width <= 420 ? 'column' : 'row',
          tall: true,
        });
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
  const pills = statusGroup(page).locator('.mb-pill');
  const before = await laidOutWidths(pills);
  for (const { label } of STATUSES) {
    const jumps = await widthJumpsWhile(pills, before, async () => {
      await pill(page, label).click();
      await expect(pill(page, label)).toHaveAttribute('aria-pressed', 'true');
    });
    expect(jumps, `${label} pressed`).toEqual([]);
  }
});

test('a pill that animates its padding while pressed is caught', async ({
  page,
}) => {
  await open(page);
  // The mutant: a press plays a 0.4 s padding animation that ends where it began.
  await page.addStyleTag({
    content: `@keyframes jump { 50% { padding-inline: 40px; } }
      .mb-pill[aria-pressed="true"] { animation: jump 0.4s; }`,
  });
  const pills = statusGroup(page).locator('.mb-pill');
  const before = await laidOutWidths(pills);
  const { label } = STATUSES[0];
  const jumps = await widthJumpsWhile(pills, before, async () => {
    await pill(page, label).click();
    await expect(pill(page, label)).toHaveAttribute('aria-pressed', 'true');
  });
  expect(jumps.length).toBeGreaterThan(0);
});
