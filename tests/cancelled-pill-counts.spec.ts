import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The Cancelled pill says how many checks passed and how many were cancelled,
// so a run stopped seconds in reads differently from one aborted at the end.
// The server tallies the counts (checks.passed, checks.cancelled); the page
// words them.
// https://github.com/alrayyes/forge-dashboard/issues/3395

function pr(number: number, title: string, checks: object) {
  return {
    forge: 'forgejo',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.test/alrayyes/app/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'cancelled',
    checks: { passed: 0, running: 0, waiting: 0, failed: 0, ...checks },
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    kind: 'regular',
  };
}

const PRS = [
  pr(1, 'Some passed', { passed: 4, cancelled: 9 }),
  pr(2, 'None passed', { passed: 0, cancelled: 13 }),
  { ...pr(3, 'Neighbour failed', { passed: 4, failed: 2 }), ci: 'failure' },
];

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('forgejo')],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const pill = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title }).locator('.ci-pill');

const text = async (page: Page, title: string) =>
  (await pill(page, title).innerText()).replace(/\s+/g, ' ').trim();

const fitsWidth = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

test.describe('Cancelled pill counts (#3395)', () => {
  test('at 1280px it reads the word and one glyphed count per state', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);

    expect(await text(page, 'Some passed')).toBe('Cancelled 4 9');
  });

  // The pill is the same capsule its neighbours are (#4323): the segmented
  // class, the label and one part per count, not a flat run of text.
  test('it is built from the same segmented parts as a failed pill', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);

    const cancelled = pill(page, 'Some passed');
    const failed = pill(page, 'Neighbour failed');
    await expect(cancelled).toHaveClass(/\bsegmented\b/);
    await expect(cancelled.locator('.ci-seg-label .ci-word')).toHaveText(
      'Cancelled',
    );
    await expect(cancelled.locator('.ci-seg-passed')).toHaveText('4');
    await expect(cancelled.locator('.ci-seg-cancelled')).toHaveText('9');
    await expect(cancelled.locator('.ci-cancel')).toHaveCount(0);
    await expect(cancelled.locator('svg.check-glyph')).toHaveCount(2);
    // The same ring the segmented neighbours draw, and one line tall like them.
    const look = (el: Element) => {
      const s = getComputedStyle(el);

      return {
        ring: s.boxShadow !== 'none',
        height: el.getBoundingClientRect().height,
        padding: s.padding,
      };
    };
    // The word takes the neutral ink of the cancelled count, not the amber the
    // segmented label falls back to.
    const ink = (sel: string) =>
      cancelled.locator(sel).evaluate((el) => getComputedStyle(el).color);
    expect(await ink('.ci-seg-label')).toBe(await ink('.ci-seg-cancelled'));
    const c = await cancelled.evaluate(look);
    const f = await failed.evaluate(look);
    expect(c.ring).toBe(true);
    expect(c.padding).toBe(f.padding);
    expect(c.height).toBe(f.height);
  });

  test('at 390px it drops the word like its neighbours and does not overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await open(page);

    expect(await text(page, 'Some passed')).toBe('4 9');
    expect(await text(page, 'Neighbour failed')).toBe('4 2');
    expect(await fitsWidth(page)).toBe(true);
  });

  test('at 320px the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await open(page);

    expect(await fitsWidth(page)).toBe(true);
  });

  test('nothing passed leaves "0 passed" out', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);

    expect(await text(page, 'None passed')).toBe('Cancelled 13');
    await expect(
      pill(page, 'None passed').locator('.ci-seg-passed'),
    ).toHaveCount(0);
  });

  test('the name and the tooltip say the counts whole', async ({ page }) => {
    await open(page);

    const name = 'Cancelled 4 9: 4 passed, 9 cancelled out of 13 checks.';
    await expect(pill(page, 'Some passed')).toHaveAttribute(
      'aria-label',
      `${name} Open pipeline`,
    );
    await expect(pill(page, 'Some passed')).toHaveAttribute('title', name);
    await expect(pill(page, 'Some passed')).toHaveAccessibleName(
      `${name} Open pipeline`,
    );
  });

  test('at 390px the pill text is not clipped', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await open(page);

    const target = pill(page, 'Some passed');
    // Nothing is clipped: the text fits inside the pill it is drawn on.
    const clipped = await target.evaluate((el) => ({
      x: el.scrollWidth > el.clientWidth,
      y: el.scrollHeight > el.clientHeight,
    }));
    expect(clipped).toEqual({ x: false, y: false });
  });

  // axe files the pill's text colour as incomplete when it cannot resolve the
  // background, so the ratio is read from the painted colours here.
  for (const mode of ['light', 'dark', 'forced-colors'] as const) {
    test(`the pill text keeps 4.5:1 in ${mode}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      if (mode === 'forced-colors') {
        await page.emulateMedia({ forcedColors: 'active' });
      } else {
        await page.emulateMedia({ colorScheme: mode });
      }
      await open(page);

      const ratio = () =>
        pill(page, 'Some passed').evaluate((el) => {
          const rgb = (c: string) => {
            const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];

            return m.slice(0, 3);
          };
          const lum = (c: number[]) => {
            const [r, g, b] = c.map((v) => {
              const s = v / 255;

              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });

            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const style = getComputedStyle(el);
          const fg = lum(rgb(style.color));
          const bg = lum(rgb(style.backgroundColor));
          const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];

          return (hi + 0.05) / (lo + 0.05);
        });
      await expect.poll(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
});
