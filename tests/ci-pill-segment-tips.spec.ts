import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
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

    await expect(p).not.toHaveAttribute('title', /.*/);
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
});
