import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// Every CI pill says how far a pipeline got: the word, then a count for each
// state that has any, each with its own glyph, for Passed and Failed as well
// as Running (#2074). The server tallies the counts, so the page is fed them
// here and only has to draw them.
// https://github.com/alrayyes/forge-dashboard/issues/2074

type Counts = {
  passed: number;
  running: number;
  waiting: number;
  failed: number;
};

function pr(number: number, title: string, ci: string, checks?: Counts) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://github.com/alrayyes/app/pull/${number}`,
    author: 'claude',
    draft: false,
    ci,
    ...(checks ? { checks } : {}),
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
  };
}

const PRS = [
  pr(1, 'Clean run', 'success', {
    passed: 12,
    running: 0,
    waiting: 0,
    failed: 0,
  }),
  pr(2, 'Mixed run', 'failure', {
    passed: 8,
    running: 1,
    waiting: 2,
    failed: 3,
  }),
  pr(3, 'Lone fail', 'failure', {
    passed: 0,
    running: 0,
    waiting: 0,
    failed: 1,
  }),
  pr(4, 'Plain pass', 'success'),
  pr(5, 'Plain fail', 'failure', {
    passed: 0,
    running: 0,
    waiting: 0,
    failed: 0,
  }),
  pr(6, 'Going', 'pending', { passed: 5, running: 2, waiting: 3, failed: 0 }),
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
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
const segments = (page: Page, title: string) =>
  pill(page, title).locator('.ci-seg:not(.ci-seg-label)');

test.describe('Passed and Failed pill counts (#2074)', () => {
  // Writes nothing per user, so it starts from the shared session.
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('a passed pull request reads Passed with its count', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'Clean run')).toHaveClass(/segmented/);
    await expect(pill(page, 'Clean run').locator('.ci-seg-label')).toHaveText(
      'Passed',
    );
    await expect(segments(page, 'Clean run')).toHaveText(['12']);
    await expect(pill(page, 'Clean run')).toHaveAttribute(
      'aria-label',
      'Passed 12: 12 passed. Open pipeline',
    );
  });

  test('a failed pull request draws a count per state that has any, in order, with checks still going', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'Mixed run').locator('.ci-seg-label')).toHaveText(
      'Failed',
    );
    await expect(segments(page, 'Mixed run')).toHaveText(['8', '1', '2', '3']);
    await expect(
      segments(page, 'Mixed run').evaluateAll((els) =>
        els.map((e) => e.className.replace('ci-seg ', '')),
      ),
    ).resolves.toEqual([
      'ci-seg-passed',
      'ci-seg-running',
      'ci-seg-waiting',
      'ci-seg-failed',
    ]);
    await expect(pill(page, 'Mixed run')).toHaveAttribute(
      'aria-label',
      'Failed 8 1 2 3: 8 passed, 1 running, 2 waiting, 3 failed. Open pipeline',
    );
    await expect(segments(page, 'Lone fail')).toHaveText(['1']);
  });

  test('each pill keeps its own state colours', async ({ page }) => {
    await open(page);

    const colour = (title: string) =>
      pill(page, title)
        .locator('.ci-seg-label')
        .evaluate((e) => getComputedStyle(e).color);
    const [passed, failed, running] = [
      await colour('Clean run'),
      await colour('Mixed run'),
      await colour('Going'),
    ];
    expect(new Set([passed, failed, running]).size).toBe(3);
  });

  test('without counts the pill stays plain', async ({ page }) => {
    await open(page);

    await expect(pill(page, 'Plain pass')).not.toHaveClass(/segmented/);
    await expect(pill(page, 'Plain pass')).toHaveText('Passed');
    await expect(pill(page, 'Plain fail')).not.toHaveClass(/segmented/);
    await expect(pill(page, 'Plain fail')).toHaveText('Failed');
  });

  test('on a phone the word goes, the counts stay, and the target is 44px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);

    for (const title of ['Clean run', 'Mixed run']) {
      await expect(pill(page, title).locator('.ci-seg-label')).toBeHidden();
      const box = await pill(page, title).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    await expect(segments(page, 'Mixed run')).toHaveText(['8', '1', '2', '3']);
  });

  test('with reduced motion the running count of a failed pipeline is still', async ({
    page,
  }) => {
    await open(page);
    const arc = pill(page, 'Mixed run').locator(
      '.ci-seg-running .check-glyph-arc',
    );
    const clock = pill(page, 'Mixed run').locator(
      '.ci-seg-running .check-glyph-clock',
    );
    await expect(arc).toBeVisible();

    await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect(arc).toBeHidden();
    await expect(clock).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      test(`has no axe violations in ${theme} mode at ${width}px`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 800 });
        await open(page);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
