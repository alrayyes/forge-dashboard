import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import {
  allowedActionsFor,
  kindFor,
  statusFor,
} from './allowed-actions-stand-in';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

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
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
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
  await page.route('**/api/dashboard*', (route: Route) =>
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
  return { slot, pill };
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
  // Reads mocked data only, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

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
    const failed = await weight();
    await push(page, [makePR(1, { ci: 'success' })]);
    await expect(firstRow(page).locator('.ci-pill')).toHaveText('Passed');
    expect(failed).toBeGreaterThan(await weight());
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
    const style = await chip.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        border: s.borderTopWidth,
        animation: s.animationName,
        icon: el.querySelector('svg') !== null,
        glyphAnimation: getComputedStyle(el.querySelector('svg') as Element)
          .animationName,
        height: el.getBoundingClientRect().height,
      };
    });
    expect(style.background).toBe('rgba(0, 0, 0, 0)');
    expect(style.border).toBe('1px');
    expect(style.animation).toBe('none');
    expect(style.glyphAnimation).toBe('none');
    expect(style.icon).toBe(true);
    // Smaller than the CI slot.
    const slot = await row.locator('.ci-slot').boundingBox();
    expect(style.height).toBeLessThan(slot?.height ?? 0);
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
            ci: 'success',
          }),
        ]);
        const chip = firstRow(page).locator('.attr-chip.auto-merge');
        await expect(chip).toContainText('Managed by Forge Dashboard');
        const fit = await chip.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const cluster = (
            el.parentElement as HTMLElement
          ).getBoundingClientRect();
          const inside = (r: DOMRect, outer: DOMRect) =>
            r.left >= outer.left - 0.5 &&
            r.right <= outer.right + 0.5 &&
            r.top >= outer.top - 0.5 &&
            r.bottom <= outer.bottom + 0.5;
          return {
            chipInCluster: box.right <= cluster.right + 0.5,
            clipped: el.scrollWidth > el.clientWidth,
            children: [...el.children].map((c) =>
              inside(c.getBoundingClientRect(), box),
            ),
            noteWidth: (el.querySelector('.pill-note') as HTMLElement)
              .scrollWidth,
            note: (el.querySelector('.pill-note') as HTMLElement).clientWidth,
          };
        });
        expect(fit.chipInCluster).toBe(true);
        expect(fit.clipped).toBe(false);
        expect(fit.children.every(Boolean)).toBe(true);
        expect(fit.noteWidth).toBeLessThanOrEqual(fit.note);
      });
    }
  }

  test('no attribute chip uses a state colour', async ({ page }) => {
    await open(page, [everything()], '/bots.html');
    const colours = await firstRow(page)
      .locator('.attr-chip')
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
          text: el.textContent,
          colour: getComputedStyle(el).color,
          isState: states.includes(getComputedStyle(el).color),
        }));
      });
    expect(colours.length).toBe(4);
    for (const c of colours) expect(c.isState, c.text ?? '').toBe(false);
  });

  test('draft, bot and out of date sit in the attribute cluster', async ({
    page,
  }) => {
    await open(page, [everything()], '/bots.html');
    const cluster = firstRow(page).locator('.attr-cluster');
    for (const name of ['Draft', 'Bot', 'Out of date', 'Auto-merge']) {
      await expect(
        cluster.locator('.attr-chip', { hasText: name }),
      ).toBeVisible();
    }
    await expect(firstRow(page).locator('.ci-slot .attr-chip')).toHaveCount(0);
    // Draft is no longer a badge beside the title.
    await expect(firstRow(page).locator('.draft-badge')).toHaveCount(0);
  });

  test('desktop order is the CI slot, then the attributes, then the open control', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, [everything()], '/bots.html');
    const row = firstRow(page);
    const slot = await row.locator('.ci-slot').boundingBox();
    const cluster = await row.locator('.attr-cluster').boundingBox();
    const details = await row.locator('.go').boundingBox();
    expect(slot && cluster && details).toBeTruthy();
    expect((slot?.x ?? 0) + (slot?.width ?? 0)).toBeLessThanOrEqual(
      (cluster?.x ?? 0) + 1,
    );
    expect(cluster?.x ?? 0).toBeLessThan(details?.x ?? 0);
  });

  test('a 360px card has no overflow, the slot first and attributes on their own line', async ({
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
    // The slot sits at the right, the attributes on a line below it.
    expect((slot?.x ?? 0) + (slot?.width ?? 0)).toBeGreaterThan(
      (card?.x ?? 0) + (card?.width ?? 0) - 40,
    );
    expect(cluster?.y ?? 0).toBeGreaterThanOrEqual(
      (slot?.y ?? 0) + (slot?.height ?? 0) - 1,
    );
    expect((cluster?.x ?? 0) + (cluster?.width ?? 0)).toBeLessThanOrEqual(
      (card?.x ?? 0) + (card?.width ?? 0) + 1,
    );
    const pill = await row.locator('.ci-pill').boundingBox();
    expect(pill?.height).toBeGreaterThanOrEqual(44);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`has no axe violations in ${theme} mode with every chip present`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await open(page, [everything()], '/bots.html');
      await expect(firstRow(page).locator('.attr-chip')).toHaveCount(4);
      const results = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
