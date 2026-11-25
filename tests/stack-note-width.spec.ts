import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The "Depends on #N..." note of a stacked pull request lived in the narrow
// title track, so it broke into lines of three or four words and the row grew
// tall. It now reads at a measure of its own, and the Stack chip and its
// one-line summary share a line.
// https://github.com/alrayyes/forge-dashboard/issues/4775

let clock = Date.now();
function pr(number: number, over: Record<string, unknown>) {
  clock -= 60_000;
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `PR ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    mergeStatus: 'mergeable',
    labels: [],
    createdAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock).toISOString(),
    behind: false,
    stack: null,
    stackedOn: null,
    stackChildren: [],
    baseBranch: 'main',
    headBranch: `branch-${number}`,
    crossRepository: false,
    ...over,
  };
}

const PRS = [
  pr(900, { title: 'Not stacked' }),
  pr(839, {
    title: 'Top of the stack',
    stack: { position: 2, size: 2 },
    stackedOn: { number: 838, url: 'https://example.com/838' },
    baseBranch: 'branch-838',
    allowedActions: [
      {
        action: 'merge',
        blocked: {
          code: 'stacked',
          message: 'Stacked on #838. Merge that one first.',
          next: 'Merge unlocks once #838 merges and this pull request is retargeted.',
        },
      },
      { action: 'close' },
    ],
  }),
  pr(838, {
    title: 'Bottom of the stack',
    stack: { position: 1, size: 2 },
    stackChildren: [839],
  }),
];

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: false }),
    }),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: PRS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows .row')).toHaveCount(PRS.length);
}

const rowFor = (page: Page, n: number) =>
  page.locator(`#pr-rows .row[data-pr-key$="#${n}"]`);

// A tablet or a narrow desktop window: the note and the reason used to wrap
// into two bands of about 430px, so a dependent row was 2.3 times a plain one.
// https://github.com/alrayyes/forge-dashboard/issues/4784
for (const width of [761, 900, 1000]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`stacked row height at ${width}px, ${colorScheme} (#4784)`, () => {
      test.use({ colorScheme });

      test('a dependent row is a plain row plus a chip line plus two note lines at most', async ({
        page,
      }) => {
        await open(page, width);
        const plain = (await rowFor(page, 900).boundingBox())!.height;
        const dependent = (await rowFor(page, 839).boundingBox())!.height;
        // Chip line (26px) and a gap, then two lines of the note at 0.75rem,
        // and the 4px of padding the reason beside it carries.
        expect(dependent).toBeLessThanOrEqual(plain + 26 + 8 + 2 * 18 + 8);
      });

      test('the note still wraps at 28ch or more and nothing overflows', async ({
        page,
      }) => {
        await open(page, width);
        const row = rowFor(page, 839);
        const m = await row.locator('.stack-note').evaluate((el) => {
          const cs = getComputedStyle(el);
          const probe = document.createElement('span');
          probe.style.cssText = `position:absolute;visibility:hidden;font:${cs.font}`;
          probe.textContent = '0'.repeat(28);
          document.body.appendChild(probe);
          const ch28 = probe.getBoundingClientRect().width;
          probe.remove();
          return { width: el.getBoundingClientRect().width, ch28 };
        });
        expect(m.width).toBeGreaterThanOrEqual(m.ch28);
        const overflow = await row.evaluate(
          (el) => el.scrollWidth - el.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      });

      test('tab order is title, CI pill, Merge, then the chip, before and after a resize', async ({
        page,
      }) => {
        await open(page, width);
        const follows = () =>
          rowFor(page, 839).evaluate((row) => {
            const chip = row.querySelector('.stack-chip')!;
            const after = (sel: string) =>
              !!(
                row.querySelector(sel)!.compareDocumentPosition(chip) &
                Node.DOCUMENT_POSITION_FOLLOWING
              );
            return after('.title') && after('.ci-pill') && after('.row-action');
          });
        expect(await follows()).toBe(true);
        await page.setViewportSize({ width: width + 40, height: 900 });
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(follows).toBe(true);
      });

      test('has no axe violations', async ({ page }) => {
        await open(page, width);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    });
  }
}

for (const width of [1280, 390]) {
  test.describe(`stack note at ${width}px (#4775)`, () => {
    test('the note reads at a measure of at least 28ch in at most four lines', async ({
      page,
    }) => {
      await open(page, width);
      const m = await rowFor(page, 839)
        .locator('.stack-note')
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          const probe = document.createElement('span');
          probe.style.cssText = `position:absolute;visibility:hidden;font:${cs.font}`;
          probe.textContent = '0'.repeat(28);
          document.body.appendChild(probe);
          const ch28 = probe.getBoundingClientRect().width;
          probe.remove();
          const r = document.createRange();
          r.selectNodeContents(el);
          const lines = new Set(
            Array.from(r.getClientRects(), (q) => Math.round(q.top)),
          ).size;
          return {
            width: el.getBoundingClientRect().width,
            ch28,
            lines,
          };
        });
      expect(m.width).toBeGreaterThanOrEqual(m.ch28);
      expect(m.lines).toBeLessThanOrEqual(4);
    });

    test('the Stack chip and its summary sit on one line', async ({ page }) => {
      await open(page, width);
      for (const n of [838, 839]) {
        const row = rowFor(page, n);
        const chip = await row.locator('.stack-chip').boundingBox();
        const wait = await row.locator('.stack-wait').boundingBox();
        expect(chip && wait).toBeTruthy();
        expect(
          Math.abs(chip!.y + chip!.height / 2 - (wait!.y + wait!.height / 2)),
        ).toBeLessThan(6);
      }
    });

    test('the stack block is a chip line plus at most two note lines, and the base row is one note line taller than a plain one', async ({
      page,
    }) => {
      await open(page, width);
      const box = async (loc: ReturnType<typeof rowFor>) =>
        (await loc.boundingBox())!;
      const plain = (await box(rowFor(page, 900))).height;
      // One chip line (about 26px) under the row's own line.
      expect((await box(rowFor(page, 838))).height).toBeLessThanOrEqual(
        plain + 40,
      );
      // Chip line plus two lines of the note at 0.75rem.
      expect(
        (await box(rowFor(page, 839).locator('.stack-info'))).height,
      ).toBeLessThanOrEqual(26 + 8 + 2 * 18);
    });

    test('the "Stacked on" reason reads at 28ch or more in at most four lines and the row stays short', async ({
      page,
    }) => {
      await open(page, width);
      const row = rowFor(page, 839);
      const m = await row.locator('.status-area').evaluate((el) => {
        const cs = getComputedStyle(el);
        const probe = document.createElement('span');
        probe.style.cssText = `position:absolute;visibility:hidden;font:${cs.font}`;
        probe.textContent = '0'.repeat(28);
        document.body.appendChild(probe);
        const ch28 = probe.getBoundingClientRect().width;
        probe.remove();
        const text = el.querySelector('.status-area-text')!;
        const lh = Number.parseFloat(cs.lineHeight);
        return {
          width: text.getBoundingClientRect().width,
          ch28,
          lines: Math.round(text.getBoundingClientRect().height / lh),
        };
      });
      expect(m.width).toBeGreaterThanOrEqual(m.ch28);
      expect(m.lines).toBeLessThanOrEqual(4);
      const plain = (await rowFor(page, 900).boundingBox())!.height;
      const dependent = (await row.boundingBox())!.height;
      // The criterion: a plain row plus a chip line and two note lines. At
      // 1280px the note and the reason sit side by side, so that is about
      // 55 + 12 + 26 + 36. The phone card is taller by design.
      expect(dependent).toBeLessThanOrEqual(width === 1280 ? 135 : 370);
      expect(plain).toBeLessThanOrEqual(width === 1280 ? 60 : 230);
    });

    test('the stack block follows the interactive cells of the row in tab order, before and after a resize', async ({
      page,
    }) => {
      if (width !== 1280) return;
      await open(page, width);
      const follows = () =>
        rowFor(page, 839).evaluate((row) => {
          const chip = row.querySelector('.stack-chip')!;
          const after = (sel: string) =>
            !!(
              row.querySelector(sel)!.compareDocumentPosition(chip) &
              Node.DOCUMENT_POSITION_FOLLOWING
            );
          return after('.title') && after('.ci-pill') && after('.row-action');
        });
      expect(await follows()).toBe(true);
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect.poll(follows).toBe(true);
    });

    test('the chip keeps focus when the layout crosses the phone breakpoint', async ({
      page,
    }) => {
      if (width !== 1280) return;
      await open(page, width);
      const chip = rowFor(page, 839).locator('.stack-chip');
      await chip.focus();
      await page.setViewportSize({ width: 390, height: 900 });
      await expect(chip).toBeFocused();
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(chip).toBeFocused();
    });

    test('has no axe violations', async ({ page }) => {
      await open(page, width);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}
