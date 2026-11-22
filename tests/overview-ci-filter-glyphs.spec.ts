import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { laidOutWidths, widthJumpsWhile } from './pill-width-helper';
import { test } from './server-fixture';

// The pull request overview's CI filter draws the same glyphs, tones and pressed
// treatment as the Main branches status filter, from the one shared component,
// so one shape means one state on every page (#4246).
// https://github.com/alrayyes/forge-dashboard/issues/4246
// https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html

const STATES = [
  {
    ci: 'failure',
    label: 'Failing',
    glyph: 'cross',
    tone: '--critical',
    bg: '--critical-bg',
  },
  {
    ci: 'pending',
    label: 'Running',
    glyph: 'arc',
    tone: '--warning',
    bg: '--warning-bg',
  },
  {
    ci: 'success',
    label: 'Passing',
    glyph: 'check',
    tone: '--good',
    bg: '--good-bg',
  },
  {
    ci: 'cancelled',
    label: 'Cancelled',
    glyph: 'stop',
    tone: '--ink-2',
    bg: '--neutral-bg',
  },
  {
    ci: 'none',
    label: 'No checks',
    glyph: 'slash',
    tone: '--ink-2',
    bg: '--neutral-bg',
  },
] as const;

function pr(number: number, ci: string, extra: Record<string, unknown> = {}) {
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
    ...extra,
  };
}

async function open(
  page: Page,
  scheme: 'light' | 'dark' = 'light',
  width = 1280,
  pullRequests: ReturnType<typeof pr>[] = STATES.map(({ ci }, i) =>
    pr(i + 1, ci),
  ),
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
        pullRequests,
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
    .getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) })
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

test('the pill is named by its word and its count, not its glyph', async ({
  page,
}) => {
  await open(page);
  for (const { label } of STATES) {
    await expect(
      page
        .locator('.filter-bar .quick-pills[data-group="ci"]')
        .getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) }),
    ).toBeVisible();
  }
});

test('only the glyph is coloured until the pill is pressed', async ({
  page,
}) => {
  await open(page);
  const readColours = () =>
    page
      .locator('.filter-bar .quick-pills[data-group="ci"] .ci-filter-pill')
      .evaluateAll((pills) =>
        pills.map((p) => ({
          glyph: getComputedStyle(p.querySelector('svg') as Element).color,
          word: getComputedStyle(p).color,
          bg: getComputedStyle(p).backgroundColor,
        })),
      );
  // Cancelled and No checks share the neutral tone, so the glyph shape is
  // what tells them apart (the other three differ by colour too). Retries
  // until every pill is painted, so one unstyled read can't pass or fail it.
  await expect
    .poll(async () => {
      const colours = await readColours();
      return {
        count: colours.length,
        sameWord: colours.every((c) => c.word === colours[0].word),
        sameBg: colours.every((c) => c.bg === colours[0].bg),
        glyphs: new Set(colours.map((c) => c.glyph)).size,
      };
    })
    .toEqual({
      count: STATES.length,
      sameWord: true,
      sameBg: true,
      glyphs: new Set(STATES.map((s) => s.tone)).size,
    });
});

for (const scheme of ['light', 'dark'] as const) {
  for (const { label, tone, bg } of STATES) {
    test(`a pressed ${label} pill takes its state's pair and an inset ring, with no tick, in ${scheme}`, async ({
      page,
    }) => {
      await open(page, scheme);
      await visible(page, label).click();
      await expect(visible(page, label)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(visible(page, label)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const read = () =>
        visible(page, label).evaluate(
          (b, vars) => {
            const probe = document.createElement('i');
            document.body.append(probe);
            const resolved = (v: string) => {
              probe.style.color = `var(${v})`;

              return getComputedStyle(probe).color;
            };
            const s = getComputedStyle(b);
            const out = {
              tone: resolved(vars.tone),
              toneBg: resolved(vars.bg),
              color: s.color,
              bg: s.backgroundColor,
              shadow: s.boxShadow,
              tick: getComputedStyle(b, '::before').content,
            };
            probe.remove();

            return out;
          },
          { tone, bg },
        );
      // Retries until the pill has taken its state's pair and ring.
      await expect
        .poll(async () => {
          const got = await read();
          return {
            bg: got.bg === got.toneBg,
            color: got.color === got.tone,
            ring: got.shadow.includes('inset') && got.shadow.includes(got.tone),
            // The glyph and the ring carry the pick, so the tick goes.
            tick: ['none', 'normal'].includes(got.tick),
          };
        })
        .toEqual({ bg: true, color: true, ring: true, tick: true });
    });
  }
}

test("All keeps the shared pill's accent fill and its tickless look when pressed", async ({
  page,
}) => {
  await open(page);
  await visible(page, 'Failing').click();
  await page
    .locator('.filter-bar .quick-pills[data-group="ci"]')
    .getByRole('button', { name: /^All( \d+)?$/ })
    .click();
  const all = page
    .locator('.filter-bar .quick-pills[data-group="ci"]')
    .getByRole('button', { name: /^All( \d+)?$/ });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  const accent = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--pill-active)';
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();

    return c;
  });
  await expect(all).toHaveCSS('background-color', accent);
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
});

test('pressing a pill does not change its width', async ({ page }) => {
  await open(page);
  const group = page.locator('.filter-bar .quick-pills[data-group="ci"]');
  const pills = group.locator('.ci-filter-pill');
  const before = await laidOutWidths(pills);
  for (const { label } of STATES) {
    const jumps = await widthJumpsWhile(pills, before, async () => {
      await visible(page, label).click();
      await expect(visible(page, label)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(jumps, `${label} pressed`).toEqual([]);
  }
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test(`the CI filter passes axe, does not overflow and keeps its targets in ${scheme} at ${width}px`, async ({
      page,
    }) => {
      await open(page, scheme, width);
      await visible(page, 'Running').click();
      await expectAxeClean(page);
    });

    test(`the CI filter with Cancelled pressed passes axe and keeps its targets in ${scheme} at ${width}px`, async ({
      page,
    }) => {
      await open(page, scheme, width);
      await visible(page, 'Cancelled').click();
      await expect(visible(page, 'Cancelled')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expectAxeClean(page);
    });
  }
}

async function expectAxeClean(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);

  const layout = await page.evaluate(() => {
    const el = document.documentElement;
    const heights = [...document.querySelectorAll('.ci-filter-pill')]
      .filter((p) => (p as HTMLElement).offsetParent !== null)
      // The drawn pill is 32px; its ::after reaches 7px past each edge, so
      // the target is the drawn height and both reaches (#4611).
      .map((p) => {
        const reach = Math.abs(
          Number.parseFloat(getComputedStyle(p, '::after').top),
        );

        return p.getBoundingClientRect().height + 2 * reach;
      });

    return { scrolls: el.scrollWidth > el.clientWidth, heights };
  });
  expect(layout.scrolls).toBe(false);
  expect(layout.heights.length).toBeGreaterThan(0);
  if (width <= 760) {
    expect(Math.min(...layout.heights)).toBeGreaterThanOrEqual(44);
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
    group.getByRole('button', { name: /^Failing( \d+)?$/ }),
  ).toBeVisible();
  await expect(group.locator('[data-pill="no-checks"]')).toBeHidden();
  await expect(group.locator('svg[data-glyph="slash"]')).toBeHidden();
});

test('every CI filter pill ships with aria-pressed, before any script runs', async ({
  page,
}) => {
  // syncQuickPills sets the attribute on load, so a page that is read before
  // its script runs, or whose script fails, is the only place a dropped
  // initial attribute shows. Read the served markup, not the live DOM.
  const response = await page.request.get('/pull-requests.html');
  expect(response.ok()).toBe(true);
  const html = await response.text();
  const pills = html.match(/<button\b[^>]*\bci-filter-pill\b[^>]*>/g) ?? [];
  // Four states, in the bar and again in the phone sheet.
  expect(pills.length).toBe(STATES.length * 2);
  for (const pill of pills) {
    expect(pill).toMatch(/\baria-pressed="false"/);
  }
});

// The Cancelled pill (#4331) keeps exactly the rows that read Cancelled: the
// server's own `ci: cancelled`, the state the row's pill draws.
// https://github.com/alrayyes/forge-dashboard/issues/4331
const MIXED = [
  pr(1, 'cancelled', { title: 'Stopped run one' }),
  pr(2, 'success', { title: 'Green run' }),
  pr(3, 'cancelled', {
    title: 'Stopped run two',
    mergeStatus: 'conflicting',
  }),
  pr(4, 'failure', { title: 'Red run' }),
  pr(5, 'none', { title: 'Unchecked run' }),
  pr(6, 'pending', { title: 'Busy run' }),
];

const rowTitles = (page: Page) =>
  page.locator('#pr-rows > .row').allTextContents();

test('the Cancelled pill is named by its word and shows only cancelled rows', async ({
  page,
}) => {
  await open(page, 'light', 1280, MIXED);
  const pill = visible(page, 'Cancelled');
  await expect(pill).toHaveAttribute('aria-pressed', 'false');
  await pill.click();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  const titles = await rowTitles(page);
  expect(titles.join('|')).toContain('Stopped run one');
  expect(titles.join('|')).toContain('Stopped run two');
  // The chip says what is filtering.
  await expect(page.locator('#active-filters')).toContainText('Cancelled');
});

test('the Cancelled pill combines with a pill of another group', async ({
  page,
}) => {
  await open(page, 'light', 1280, MIXED);
  await visible(page, 'Cancelled').click();
  await page
    .locator('.quick-pills[data-group="merge"]')
    .getByRole('button', { name: /^Conflicting( \d+)?$/ })
    .and(page.locator(':visible'))
    .click();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
  expect((await rowTitles(page)).join('|')).toContain('Stopped run two');
});

test('the Cancelled pick is kept across a reload', async ({ page }) => {
  await open(page, 'light', 1280, MIXED);
  await visible(page, 'Cancelled').click();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  await page.reload();
  await expect(visible(page, 'Cancelled')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
});

test('the Cancelled pill works in the phone sheet too', async ({ page }) => {
  await open(page, 'light', 390, MIXED);
  const pill = visible(page, 'Cancelled');
  await pill.click();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(visible(page, 'Cancelled')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pr-rows > .row:visible')).toHaveCount(2);
});

test('with nothing cancelled the pill is not offered', async ({ page }) => {
  await open(page, 'light', 1280, [pr(1, 'success'), pr(2, 'failure')]);
  await expect(
    page
      .locator('.filter-bar .quick-pills[data-group="ci"]')
      .locator('[data-pill="cancelled"]'),
  ).toBeHidden();
});
