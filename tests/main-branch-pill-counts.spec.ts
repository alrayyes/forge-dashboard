import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// The pills on the Main branches page say how far a default branch's pipeline
// got, as the pull request pages do (#2074). The server tallies the counts
// (`checks` on each row of GET /api/main-branches); the page only draws them.
// https://github.com/alrayyes/forge-dashboard/issues/2074

type Status = 'failed' | 'running' | 'passed' | 'cancelled' | 'none';
type Counts = {
  passed: number;
  running: number;
  waiting: number;
  failed: number;
};

const none: Counts = { passed: 0, running: 0, waiting: 0, failed: 0 };

function row(fullName: string, status: Status, checks: Counts | undefined) {
  return {
    forge: 'github',
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status,
    commit: {
      sha: 'd98f3c2',
      subject: `fix: change in ${fullName}`,
      author: 'sre-dev',
      committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    failingJobs: status === 'failed' ? ['lint'] : [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    ...(checks ? { checks } : {}),
    stale: false,
    staleSince: null,
  };
}

const BRANCHES = [
  row('acme/red', 'failed', { passed: 8, running: 1, waiting: 2, failed: 3 }),
  row('acme/going', 'running', {
    passed: 5,
    running: 2,
    waiting: 3,
    failed: 0,
  }),
  row('acme/green', 'passed', {
    passed: 12,
    running: 0,
    waiting: 0,
    failed: 0,
  }),
  row('acme/plain', 'passed', none),
  row('acme/older', 'failed', undefined),
  row('acme/stopped', 'cancelled', {
    passed: 2,
    running: 0,
    waiting: 0,
    failed: 0,
  }),
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 2,
          passed: 2,
          running: 1,
          cancelled: 1,
          awaitingApproval: 0,
          none: 0,
          total: BRANCHES.length,
        },
        branches: BRANCHES,
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
    BRANCHES.length,
  );
}

const pill = (page: Page, repo: string) =>
  page
    .locator('[data-testid="main-branch-row"]', { hasText: repo })
    .locator('.ci-pill');
const segments = (page: Page, repo: string) =>
  pill(page, repo).locator('.ci-seg:not(.ci-seg-label)');

test.describe('Main branches pill counts (#2074)', () => {
  test('a failed branch draws its counts in order, with checks still going', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'acme/red').locator('.ci-seg-label')).toHaveText(
      'Failed',
    );
    await expect(segments(page, 'acme/red')).toHaveText(['8', '1', '2', '3']);
    await expect(pill(page, 'acme/red')).toHaveAttribute(
      'aria-label',
      'Failed 8 1 2 3: 8 passed, 1 running, 2 waiting, 3 failed. Open pipeline',
    );
  });

  test('a running and a passed branch draw theirs', async ({ page }) => {
    await open(page);

    await expect(segments(page, 'acme/going')).toHaveText(['5', '2', '3']);
    await expect(pill(page, 'acme/going')).toHaveAttribute(
      'aria-label',
      'Running 5 2 3: 5 passed, 2 running, 3 waiting. Open pipeline',
    );
    await expect(segments(page, 'acme/green')).toHaveText(['12']);
    await expect(pill(page, 'acme/green')).toHaveAttribute(
      'aria-label',
      'Passed 12: 12 passed. Open pipeline',
    );
  });

  test('a branch with no counts, or a cancelled one, keeps the plain pill', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'acme/plain')).not.toHaveClass(/segmented/);
    await expect(pill(page, 'acme/plain')).toHaveText('Passed');
    await expect(pill(page, 'acme/older')).toHaveText('Failed');
    await expect(pill(page, 'acme/stopped')).not.toHaveClass(/segmented/);
    await expect(pill(page, 'acme/stopped')).toHaveText('Cancelled');
  });

  test('each count has its own glyph and a segment is not read twice', async ({
    page,
  }) => {
    await open(page);

    await expect(
      pill(page, 'acme/red').locator('.ci-seg-waiting .check-glyph'),
    ).toHaveAttribute('data-glyph', 'hourglass');
    await expect(segments(page, 'acme/red').first()).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  test('on a phone the word goes, the counts stay, and the target is 44px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);

    await expect(pill(page, 'acme/red').locator('.ci-seg-label')).toBeHidden();
    await expect(segments(page, 'acme/red')).toHaveText(['8', '1', '2', '3']);
    const box = await pill(page, 'acme/red').boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('with reduced motion the running count is still', async ({ page }) => {
    await open(page);
    const arc = pill(page, 'acme/going').locator(
      '.ci-seg-running .check-glyph-arc',
    );
    const clock = pill(page, 'acme/going').locator(
      '.ci-seg-running .check-glyph-clock',
    );
    await expect(arc).toBeVisible();

    await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect(arc).toBeHidden();
    await expect(clock).toBeVisible();
  });

  test('has no axe violations in light and dark, desktop and 390px', async ({
    page,
  }) => {
    await open(page);

    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await page.reload();
      await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
        BRANCHES.length,
      );
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 800 },
      ]) {
        await page.setViewportSize(size);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, `${theme} ${size.width}px`).toEqual([]);
      }
    }
    await setTheme(page, 'light');
  });
});
