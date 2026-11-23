import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import {
  allowedActionsFor,
  kindFor,
  statusFor,
} from './allowed-actions-stand-in';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #1563 slice 1: a row draws three kinds of thing as three tiers. State
// (running) and outcome (failed, passed) share one fixed CI slot, so a run
// turns into its result without the row moving. Attributes (auto-merge on,
// draft, bot, out of date) are quiet outlined chips in a group of their own.
// https://github.com/alrayyes/forge-dashboard/issues/1563

declare global {
  interface Window {
    __push: (data: unknown) => void;
  }
}

type MockPR = Record<string, unknown> & { number: number };

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date(Date.now() - number * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 60_000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  } as MockPR;
}

function snapshot(prs: MockPR[]) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [forgeHealth('github')],
    pullRequests: prs.map((pr) => ({
      allowedActions: allowedActionsFor(pr as never),
      status: statusFor(pr as never),
      kind: kindFor(pr as never),
      ...pr,
    })),
    issues: [],
    openIssueCount: 0,
  };
}

async function open(page: Page, prs: MockPR[], url = '/pull-requests.html') {
  // The stub has to be in place before the dashboard opens its stream, and it
  // lets the test decide exactly when the next snapshot arrives.
  await page.addInitScript(() => {
    class StubEventSource {
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor() {
        (window as unknown as { __es: StubEventSource }).__es = this;
      }
      close() {}
      addEventListener() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource =
      StubEventSource;
    window.__push = (data) =>
      (window as unknown as { __es: StubEventSource }).__es.onmessage?.({
        data: JSON.stringify(data),
      });
  });
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(prs)),
    }),
  );
  await page.goto(url);
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
}

async function push(page: Page, prs: MockPR[]) {
  await page.waitForFunction(
    () =>
      (window as unknown as { __es?: { onmessage: unknown } }).__es
        ?.onmessage != null,
  );
  await page.evaluate((data) => window.__push(data), snapshot(prs));
}

const firstRow = (page: Page) => page.locator('#pr-rows > .row').first();

async function boxes(page: Page) {
  const row = firstRow(page);
  const slot = await row.locator('.ci-slot').boundingBox();
  const pill = await row.locator('.ci-pill').boundingBox();
  // The pill is centred on its row (#4502), so its top follows the row's
  // height when a result drops a line; measure it from the row's centre.
  const rowBox = await row.boundingBox();
  const centre = (b: typeof pill) =>
    b && rowBox ? b.y + b.height / 2 - (rowBox.y + rowBox.height / 2) : null;
  return {
    slot: slot && { x: slot.x, width: slot.width, height: slot.height },
    pill: pill && { x: pill.x, width: pill.width, height: pill.height },
    fromRowCentre: Math.round(centre(pill) ?? 0),
  };
}

// A bot's pull request carrying every attribute at once.
const everything = () =>
  makePR(20, {
    title: 'Bump package-20 from 1.0.0 to 1.0.1',
    author: 'dependabot',
    kind: 'dependency',
    draft: true,
    behind: true,
    autoMergeEnabled: true,
    ci: 'failure',
  });

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.describe('row status grammar (#1563)', () => {
  test('a run turns into its result in the same box', async ({ page }) => {
    await open(page, [makePR(1)]);
    const row = firstRow(page);
    await expect(row.locator('.ci-pill')).toHaveText('Running');
    // A live glyph, not a dot.
    await expect(row.locator('.ci-pill svg[data-glyph="arc"]')).toBeAttached();
    await expect(row.locator('.ci-pill .dot')).toHaveCount(0);
    const before = await boxes(page);
    expect(before.slot).not.toBeNull();

    await push(page, [makePR(1, { ci: 'failure' })]);
    await expect(row.locator('.ci-pill')).toHaveText('Failed');
    await expect(
      row.locator('.ci-pill svg[data-glyph="cross"]'),
    ).toBeAttached();
    expect(await boxes(page)).toEqual(before);

    await push(page, [makePR(1, { ci: 'pending' })]);
    await expect(row.locator('.ci-pill')).toHaveText('Running');
    await push(page, [makePR(1, { ci: 'success' })]);
    await expect(row.locator('.ci-pill')).toHaveText('Passed');
    await expect(
      row.locator('.ci-pill svg[data-glyph="check"]'),
    ).toBeAttached();
    expect(await boxes(page)).toEqual(before);
  });

  test('failed is the strongest weight, passed the calmest', async ({
    page,
  }) => {
    await open(page, [makePR(1, { ci: 'failure' })]);
    const weight = () =>
      firstRow(page)
        .locator('.ci-pill')
        .evaluate((el) => Number(getComputedStyle(el).fontWeight));
    await expect.poll(weight).toBeGreaterThan(0);
    const failed = await weight();
    await push(page, [makePR(1, { ci: 'success' })]);
    await expect(firstRow(page).locator('.ci-pill')).toHaveText('Passed');
    await expect.poll(weight).toBeLessThan(failed);
  });

  test('the running glyph keeps still under reduced motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, [makePR(1)]);
    const pill = firstRow(page).locator('.ci-pill');
    await expect(pill.locator('svg[data-glyph="arc"]')).toBeHidden();
    await expect(pill.locator('svg[data-glyph="clock"]')).toBeVisible();
    const running = await pill.evaluate((el) =>
      el.getAnimations({ subtree: true }).map((a) => a.playState),
    );
    expect(running).not.toContain('running');
  });

  test('auto-merge on is an outlined attribute chip, never in the CI slot', async ({
    page,
  }) => {
    await open(page, [makePR(1, { autoMergeEnabled: true })]);
    const row = firstRow(page);
    const chip = row.locator('.attr-cluster .attr-chip.auto-merge');
    await expect(chip).toContainText('Auto-merge');
    await expect(row.locator('.ci-slot .attr-chip')).toHaveCount(0);
    await expect(row.locator('.ci-slot .auto-merge')).toHaveCount(0);
    await expect(chip).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(chip).toHaveCSS('border-top-width', '1px');
    await expect(chip).toHaveCSS('animation-name', 'none');
    await expect(chip.locator('svg')).toHaveCSS('animation-name', 'none');
    // Smaller than the CI slot.
    await expect
      .poll(async () => {
        const slot = (await row.locator('.ci-slot').boundingBox())?.height ?? 0;
        const height = (await chip.boundingBox())?.height ?? 0;
        return height > 0 && height < slot;
      })
      .toBe(true);
  });

  // The Forgejo chip is the longest ("Auto-merge on" and the note that the app
  // does the merging), so it is the one that can run past its outline.
  for (const width of [360, 768, 1024, 1280]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`the Forgejo auto-merge chip holds its text at ${width}px in ${theme} mode`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 900 });
        await open(page, [
          makePR(1, {
            forge: 'forgejo',
            repo: 'alrayyes/dotfiles',
            autoMergeEnabled: true,
            autoMergeHeldBy: 'dashboard',
            ci: 'success',
          }),
        ]);
        const chip = firstRow(page).locator('.attr-chip.auto-merge');
        await expect(chip).toContainText('Managed by Forge Dashboard');
        const fit = () =>
          chip.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const cluster = (
              el.parentElement as HTMLElement
            ).getBoundingClientRect();
            const inside = (r: DOMRect, outer: DOMRect) =>
              r.left >= outer.left - 0.5 &&
              r.right <= outer.right + 0.5 &&
              r.top >= outer.top - 0.5 &&
              r.bottom <= outer.bottom + 0.5;
            const note = el.querySelector('.pill-note') as HTMLElement;
            return {
              chipInCluster: box.right <= cluster.right + 0.5,
              clipped: el.scrollWidth > el.clientWidth,
              childrenInside: [...el.children].every((c) =>
                inside(c.getBoundingClientRect(), box),
              ),
              noteFits: note.scrollWidth <= note.clientWidth,
            };
          });
        await expect.poll(fit).toEqual({
          chipInCluster: true,
          clipped: false,
          childrenInside: true,
          noteFits: true,
        });
      });
    }
  }

  // Out of date is the one chip that asks to be seen, so it is drawn in the
  // warning colour on purpose (out-of-date-filter.spec.ts holds it to that).
  test('no other attribute chip uses a state colour', async ({ page }) => {
    await open(page, [everything()], '/bots.html');
    const read = () =>
      firstRow(page)
        .locator('.attr-chip:not(.behind)')
        .evaluateAll((els) => {
          const probe = document.createElement('span');
          const resolve = (token: string) => {
            probe.style.color = `var(${token})`;
            document.body.appendChild(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          };
          const states = ['--good', '--warning', '--critical', '--queued'].map(
            resolve,
          );
          return els.map((el) => ({
            text: el.textContent ?? '',
            isState: states.includes(getComputedStyle(el).color),
          }));
        });
    // Both chips are drawn and neither takes a state colour.
    await expect
      .poll(async () => {
        const chips = await read();
        return { count: chips.length, state: chips.filter((c) => c.isState) };
      })
      .toEqual({ count: 2, state: [] });
  });

  test('draft, out of date and auto-merge sit in the attribute cluster', async ({
    page,
  }) => {
    await open(page, [everything()], '/bots.html');
    const cluster = firstRow(page).locator('.attr-cluster');
    for (const name of ['Draft', 'Out of date', 'Auto-merge']) {
      await expect(
        cluster.locator('.attr-chip', { hasText: name }),
      ).toBeVisible();
    }
    await expect(firstRow(page).locator('.ci-slot .attr-chip')).toHaveCount(0);
    // Draft is no longer a badge beside the title.
    await expect(firstRow(page).locator('.draft-badge')).toHaveCount(0);
  });

  test('desktop order is the attributes under the title, then the CI slot, then the open control', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, [everything()], '/bots.html');
    const row = firstRow(page);
    const slot = await row.locator('.ci-slot').boundingBox();
    const cluster = await row.locator('.attr-cluster').boundingBox();
    const details = await row.locator('.go').boundingBox();
    expect(slot && cluster && details).toBeTruthy();
    // The attributes sit under the title, to the left of the CI slot, and the
    // open control is last (#4502).
    expect((cluster?.x ?? 0) + (cluster?.width ?? 0)).toBeLessThanOrEqual(
      (slot?.x ?? 0) + 1,
    );
    expect((slot?.x ?? 0) + (slot?.width ?? 0)).toBeLessThanOrEqual(
      (details?.x ?? 0) + 1,
    );
  });

  test('a 360px card has no overflow, the attributes above the slot line', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await open(page, [everything()], '/bots.html');
    const row = firstRow(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const slot = await row.locator('.ci-slot').boundingBox();
    const cluster = await row.locator('.attr-cluster').boundingBox();
    const card = await row.boundingBox();
    expect(slot && cluster && card).toBeTruthy();
    // The attributes sit under the title, above the line the pill is on, and
    // the slot starts at the card's left edge (#4502).
    expect((slot?.x ?? 0) - (card?.x ?? 0)).toBeLessThan(40);
    expect(slot?.y ?? 0).toBeGreaterThanOrEqual(
      (cluster?.y ?? 0) + (cluster?.height ?? 0) - 1,
    );
    expect((cluster?.x ?? 0) + (cluster?.width ?? 0)).toBeLessThanOrEqual(
      (card?.x ?? 0) + (card?.width ?? 0) + 1,
    );
    const pill = await row.locator('.ci-pill').boundingBox();
    expect(pill?.height).toBeGreaterThanOrEqual(44);
  });

  test(`has no axe violations in light and dark mode with every chip present`, async ({
    page,
  }) => {
    for (const theme of ['light', 'dark'] as const) {
      await test.step(`${theme}`, async () => {
        await page.emulateMedia({ colorScheme: theme });

        await open(page, [everything()], '/bots.html');

        await expect(firstRow(page).locator('.attr-chip')).toHaveCount(3);

        const results = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .analyze();

        expect(results.violations).toEqual([]);
      });
    }
  });
});
