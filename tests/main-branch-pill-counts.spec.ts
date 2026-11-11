import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The pills on the Main branches page say how far a default branch's pipeline
// got, as the pull request pages do (#2074). The server tallies the counts
// (`checks` on each row of GET /api/v1/main-branches); the page only draws them.
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

async function open(page: Page, branches: unknown[] = BRANCHES) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches', (route: Route) =>
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
          total: branches.length,
        },
        branches,
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
    branches.length,
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
      'Failed 8 1 2 3: 8 passed, 1 running, 2 waiting, 3 failed, still running. Open pipeline',
    );
  });

  test('a failed branch with a job still running carries the live marker', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'acme/red').locator('.ci-live')).toBeVisible();
    await expect(pill(page, 'acme/going').locator('.ci-live')).toHaveCount(0);
    await expect(pill(page, 'acme/older').locator('.ci-live')).toHaveCount(0);
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

  test('on a phone the word goes, the counts stay, with no sideways scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);

    await expect(pill(page, 'acme/red').locator('.ci-word')).toBeHidden();
    await expect(segments(page, 'acme/red')).toHaveText(['8', '1', '2', '3']);
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

  // The capsule is about 200px wide. Beside the name on a phone it left the
  // name 102px and broke it inside a word.
  // https://github.com/alrayyes/forge-dashboard/issues/3190
  test.describe('repo names beside the capsule (#3190)', () => {
    const capsule = { passed: 8, running: 1, waiting: 2, failed: 3 };
    const NAMES = [
      'example-org/api-gateway',
      'sandbox/dotfiles',
      'alrayyes/forge-dashboard',
    ];
    const repo = (page: Page, name: string) =>
      page
        .locator('[data-testid="main-branch-row"]', { hasText: name })
        .locator('.mb-repo');

    test('on a phone a name that fits stays on one line', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(
        page,
        NAMES.map((n) => row(n, 'failed', capsule)),
      );
      for (const name of NAMES) {
        const box = await repo(page, name).boundingBox();
        expect(box?.height, name).toBeLessThan(24);
      }
    });

    test('on a phone the capsule sits above the name and still opens the panel at 44px', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, [row(NAMES[1], 'failed', capsule)]);
      const r = page.locator('[data-testid="main-branch-row"]');
      const pill = await r.locator('.ci-pill').boundingBox();
      const name = await r.locator('.mb-repo').boundingBox();
      expect((pill?.y ?? 0) + (pill?.height ?? 0)).toBeLessThanOrEqual(
        name?.y ?? 0,
      );
      expect(pill?.height).toBeGreaterThanOrEqual(44);
    });

    test('a name longer than the row wraps at a hyphen, not inside a word', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, [
        row(
          'acme/very-long-repository-name-for-the-wrapping-check',
          'failed',
          capsule,
        ),
      ]);
      const lines = await page.evaluate(() => {
        const el = document.querySelector('.mb-repo');
        if (!el) throw new Error('no repo name');
        const range = document.createRange();
        const text = el.firstChild as Text;
        const out: string[] = [];
        let top = -1;
        let line = '';
        for (let i = 0; i < text.length; i++) {
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          const y = Math.round(range.getBoundingClientRect().top);
          if (top !== -1 && y !== top) {
            out.push(line);
            line = '';
          }
          top = y;
          line += text.data[i];
        }
        out.push(line);
        return out;
      });
      expect(lines.length).toBeGreaterThan(1);
      for (const l of lines.slice(0, -1)) expect(l).toMatch(/[-/]$/);
    });

    test('above 420px the capsule stays top right of the row', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 820, height: 800 });
      await open(page, [row(NAMES[1], 'failed', capsule)]);
      const r = page.locator('[data-testid="main-branch-row"]');
      const pill = await r.locator('.ci-pill').boundingBox();
      const name = await r.locator('.mb-repo').boundingBox();
      expect(pill?.x ?? 0).toBeGreaterThan((name?.x ?? 0) + (name?.width ?? 0));
    });
  });
});
