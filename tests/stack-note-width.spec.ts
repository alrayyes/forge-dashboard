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

    test('the Stack chip and its summary sit on one line, with no separator dot', async ({
      page,
    }) => {
      await open(page, width);
      for (const n of [838, 839]) {
        const row = rowFor(page, n);
        const chip = await row.locator('.stack-chip').boundingBox();
        const wait = await row.locator('.stack-wait').boundingBox();
        expect(chip && wait).toBeTruthy();
        expect(
          Math.abs(chip!.y + chip!.height / 2 - (wait!.y + wait!.height / 2)),
        ).toBeLessThan(6);
        await expect(row.locator('.stack-sep:visible')).toHaveCount(0);
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
      // At 1280px: the row (55px), the chip line, the note's two lines and the
      // reason's two lines, 183px as drawn. The phone card is taller by design.
      expect(dependent).toBeLessThanOrEqual(width === 1280 ? 190 : 370);
      expect(plain).toBeLessThanOrEqual(width === 1280 ? 60 : 230);
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
