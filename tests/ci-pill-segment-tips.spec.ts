import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { installFakeStream, pushStream } from './fake-stream-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Pointing at, focusing or tapping a section of a CI pill says what it counts
// ("7 checks passed"), the same on every pill.
// https://github.com/alrayyes/forge-dashboard/issues/4422

function pr(number: number, title: string, ci: string, checks: object) {
  return {
    forge: 'forgejo',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.test/alrayyes/app/pull/${number}`,
    author: 'claude',
    draft: false,
    ci,
    checks: { passed: 0, running: 0, waiting: 0, failed: 0, ...checks },
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    kind: 'regular',
  };
}

const PRS = [
  pr(1, 'Mixed run', 'failure', { passed: 7, running: 1, failed: 3 }),
  pr(2, 'Stopped run', 'cancelled', { passed: 4, cancelled: 9 }),
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

// The pill's children take no pointer events (a redraw must not eat a press),
// so Playwright's actionability check sees the button on top. `force` skips it
// and hovers or taps the coordinates, which is what the tip reads.
const pill = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title }).locator('.ci-pill');
const tip = (page: Page) => page.locator('[role="tooltip"].ci-pill-tip');
const inViewport = (page: Page) =>
  tip(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.left >= 0 &&
      r.top >= 0 &&
      r.right <= window.innerWidth &&
      r.bottom <= window.innerHeight
    );
  });

test.describe('CI pill segment tooltips (#4422)', () => {
  test('hovering a segment names its count, singular and plural', async ({
    page,
  }) => {
    await open(page);
    const p = pill(page, 'Mixed run');

    await p.locator('.ci-seg-passed').hover({ force: true });
    await expect(tip(page)).toHaveText('7 checks passed');
    await p.locator('.ci-seg-running').hover({ force: true });
    await expect(tip(page)).toHaveText('1 check running');
    await p.locator('.ci-seg-failed').hover({ force: true });
    await expect(tip(page)).toHaveText('3 checks failed');
    await page.mouse.move(0, 0);
    await expect(tip(page)).toBeHidden();
  });

  test('keyboard focus shows it and arrow keys follow the segments', async ({
    page,
  }) => {
    await open(page);
    const p = pill(page, 'Mixed run');

    await p.focus();
    await expect(tip(page)).toHaveText('7 checks passed');
    await expect(p).toHaveAttribute('aria-describedby', /.+/);
    await page.keyboard.press('ArrowRight');
    await expect(tip(page)).toHaveText('1 check running');
    await page.keyboard.press('ArrowLeft');
    await expect(tip(page)).toHaveText('7 checks passed');
    // Escape dismisses it and leaves focus where it was.
    await page.keyboard.press('Escape');
    await expect(tip(page)).toBeHidden();
    await expect(p).toBeFocused();
    await expect(p).not.toHaveAttribute('aria-describedby');
    await expect(p).toHaveAccessibleName(/Open pipeline$/);
  });

  test('the pointer can move onto the tooltip without it vanishing', async ({
    page,
  }) => {
    await open(page);
    await pill(page, 'Mixed run')
      .locator('.ci-seg-passed')
      .hover({ force: true });
    await expect(tip(page)).toBeVisible();
    await tip(page).hover();
    // Longer than the grace period the tooltip waits before it hides.
    await page.waitForTimeout(400);
    await expect(tip(page)).toBeVisible();
  });

  test('a Cancelled pill uses the same tooltip, not a native title', async ({
    page,
  }) => {
    await open(page);
    const p = pill(page, 'Stopped run');

    await expect(p).not.toHaveAttribute('title');
    await p.locator('.ci-seg-cancelled').hover({ force: true });
    await expect(tip(page)).toHaveText('9 checks cancelled');
    await p.locator('.ci-seg-passed').hover({ force: true });
    await expect(tip(page)).toHaveText('4 checks passed');
  });

  test('on a 375px phone the tooltip stays inside the viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await open(page);
    for (const seg of ['.ci-seg-passed', '.ci-seg-failed']) {
      await pill(page, 'Mixed run').locator(seg).hover({ force: true });
      await expect(tip(page)).toBeVisible();
      expect(await inViewport(page)).toBe(true);
    }
  });

  test('the tooltip flips below a pill at the top and stays in the viewport at the edges', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await open(page);
    const p = pill(page, 'Mixed run');

    await p.scrollIntoViewIfNeeded();
    const seg = p.locator('.ci-seg-passed');
    await seg.hover({ force: true });
    const segBox = await seg.boundingBox();
    const tipBox = await tip(page).boundingBox();
    expect(tipBox).not.toBeNull();
    // Above the segment when there is room, otherwise below it.
    const above = (tipBox?.y ?? 0) + (tipBox?.height ?? 0) <= (segBox?.y ?? 0);
    const below = (tipBox?.y ?? 0) >= (segBox?.y ?? 0) + (segBox?.height ?? 0);
    expect(above || below).toBe(true);
    expect(await inViewport(page)).toBe(true);
  });

  test('scrolling closes the tooltip so it never floats off its segment', async ({
    page,
  }) => {
    await open(page);
    await pill(page, 'Mixed run')
      .locator('.ci-seg-passed')
      .hover({ force: true });
    await expect(tip(page)).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
    await expect(tip(page)).toBeHidden();
  });

  test('Escape closes the tooltip and nothing behind it', async ({ page }) => {
    await open(page);
    const p = pill(page, 'Mixed run');
    let behind = 0;
    await page.exposeFunction('behindEscape', () => behind++);
    await page.evaluate(() =>
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape')
          (window as unknown as { behindEscape(): void }).behindEscape();
      }),
    );
    await p.focus();
    await expect(tip(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip(page)).toBeHidden();
    expect(behind).toBe(0);
  });

  test('has no axe violations with the tooltip open, light and dark', async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await pill(page, 'Mixed run')
        .locator('.ci-seg-passed')
        .hover({ force: true });
      await expect(tip(page)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    }
  });
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('tapping a segment shows the text, not the dialog; the word opens it', async ({
    page,
  }) => {
    await open(page);
    const p = pill(page, 'Mixed run');
    const dialog = page.getByRole('dialog', { name: 'Pipeline checks' });

    await p.locator('.ci-seg-failed').tap({ force: true });
    await expect(tip(page)).toHaveText('3 checks failed');
    await expect(dialog).toBeHidden();
    await page.locator('h1, header').first().tap();
    await expect(tip(page)).toBeHidden();

    await p.locator('.ci-word').tap({ force: true });
    await expect(dialog).toBeVisible();
  });

  test('a tap on the body of the pill, between the parts, opens the dialog', async ({
    page,
  }) => {
    await open(page);
    const p = pill(page, 'Mixed run');
    const box = await p.boundingBox();

    await p.tap({ position: { x: 2, y: (box?.height ?? 4) / 2 }, force: true });
    await expect(
      page.getByRole('dialog', { name: 'Pipeline checks' }),
    ).toBeVisible();
  });

  test('a click with no touch press, as a screen reader sends, opens the dialog', async ({
    page,
  }) => {
    await open(page);
    const p = pill(page, 'Mixed run');

    await p.evaluate((el) => (el as HTMLElement).click());
    await expect(
      page.getByRole('dialog', { name: 'Pipeline checks' }),
    ).toBeVisible();
  });
});

test.describe('on the Main branches page', () => {
  function branches(passed: number, failed: number) {
    return {
      generatedAt: new Date().toISOString(),
      counts: {
        failed: 1,
        passed: 0,
        running: 0,
        cancelled: 0,
        awaitingApproval: 0,
        none: 0,
        total: 1,
      },
      forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
      branches: [
        {
          forge: 'github',
          fullName: 'acme/auth-service',
          url: 'https://example.com/acme/auth-service',
          branch: 'main',
          status: 'failed',
          commit: {
            sha: 'd98f3c2',
            subject: 'fix: tip',
            author: 'sre-dev',
            committedAt: new Date(Date.now() - 1800_000).toISOString(),
          },
          failingJobs: ['test'],
          finishedAt: null,
          durationSeconds: null,
          runUrl: 'https://example.com/acme/auth-service/actions/runs/1',
          checks: { passed, running: 0, waiting: 0, failed },
          staleSince: null,
        },
      ],
    };
  }

  async function openMain(page: Page, first: ReturnType<typeof branches>) {
    await installFakeStream(page);
    await page.route('**/api/v1/main-branches', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(first),
      }),
    );
    await page.goto('/');
    await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
      1,
    );
  }

  const mainPill = (page: Page) =>
    page.locator('[data-testid="main-branch-row"] .ci-pill');

  test('a segment names its count, and the pill that redraws keeps doing it', async ({
    page,
  }) => {
    await openMain(page, branches(8, 3));
    await mainPill(page).locator('.ci-seg-passed').hover({ force: true });
    await expect(tip(page)).toHaveText('8 checks passed');

    // The stream redraws the same button with new children while the tip is
    // open; the tip follows the segment and says the new count.
    await pushStream(page, { mainBranchPage: branches(9, 3) });
    await expect(tip(page)).toHaveText('9 checks passed');

    await mainPill(page).locator('.ci-seg-failed').hover({ force: true });
    await expect(tip(page)).toHaveText('3 checks failed');
  });

  test('a redraw that drops the segment closes the tip instead of orphaning it', async ({
    page,
  }) => {
    await openMain(page, branches(8, 3));
    await mainPill(page).locator('.ci-seg-failed').hover({ force: true });
    await expect(tip(page)).toHaveText('3 checks failed');

    await pushStream(page, { mainBranchPage: branches(8, 0) });
    await expect(mainPill(page).locator('.ci-seg-failed')).toHaveCount(0);
    await expect(tip(page)).toBeHidden();
    await expect(mainPill(page)).not.toHaveAttribute('aria-describedby');
  });
});
