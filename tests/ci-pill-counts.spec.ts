import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

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

function pr(
  number: number,
  title: string,
  ci: string,
  checks?: Counts,
  forge = 'github',
) {
  return {
    forge,
    repo: 'alrayyes/app',
    number,
    title,
    url:
      forge === 'github'
        ? `https://github.com/alrayyes/app/pull/${number}`
        : `https://git.example/alrayyes/app/pull/${number}`,
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
  // A Forgejo commit with 31 statuses, past one page of 30 (#3248): the server
  // tallies all of them, so the row draws counts like a GitHub one.
  pr(
    7,
    'Forgejo big pipeline',
    'pending',
    { passed: 28, running: 1, waiting: 2, failed: 0 },
    'forgejo',
  ),
];

async function open(page: Page, pullRequests = PRS) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(
    pullRequests.length,
  );
}

const pill = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title }).locator('.ci-pill');
const segments = (page: Page, title: string) =>
  pill(page, title).locator('.ci-seg:not(.ci-seg-label)');

test.describe('Passed and Failed pill counts (#2074)', () => {
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
      'Failed 8 1 2 3: 8 passed, 1 running, 2 waiting, 3 failed, still running. Open pipeline',
    );
    await expect(segments(page, 'Lone fail')).toHaveText(['1']);
  });

  test('a failed pill whose pipeline is still going says so, and one that is done does not', async ({
    page,
  }) => {
    await open(page);
    const live = (title: string) => pill(page, title).locator('.ci-live');

    await expect(live('Mixed run')).toBeVisible();
    await expect(live('Mixed run').locator('.check-glyph-arc')).toBeVisible();
    await expect(live('Lone fail')).toHaveCount(0);
    await expect(live('Going')).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect(live('Mixed run').locator('.check-glyph-arc')).toBeHidden();
    await expect(live('Mixed run').locator('.check-glyph-clock')).toBeVisible();
  });

  test('a Forgejo pull request with 31 statuses reads Running with the same counts a GitHub row draws (#3248)', async ({
    page,
  }) => {
    await open(page);

    await expect(
      pill(page, 'Forgejo big pipeline').locator('.ci-seg-label'),
    ).toHaveText('Running');
    await expect(segments(page, 'Forgejo big pipeline')).toHaveText([
      '28',
      '1',
      '2',
    ]);
    await expect(segments(page, 'Going')).toHaveText(['5', '2', '3']);
  });

  test('each pill keeps its own state colours', async ({ page }) => {
    await open(page);

    const colour = (title: string) =>
      pill(page, title)
        .locator('.ci-seg-label')
        .evaluate((e) => getComputedStyle(e).color);
    await expect
      .poll(
        async () =>
          new Set([
            await colour('Clean run'),
            await colour('Mixed run'),
            await colour('Going'),
          ]).size,
      )
      .toBe(3);
  });

  test('without counts the pill stays plain', async ({ page }) => {
    await open(page);

    await expect(pill(page, 'Plain pass')).not.toHaveClass(/segmented/);
    await expect(pill(page, 'Plain pass')).toHaveText('Passed');
    await expect(pill(page, 'Plain fail')).not.toHaveClass(/segmented/);
    await expect(pill(page, 'Plain fail')).toHaveText('Failed');
  });

  // The phone card's pill keeps its word, as the approved design shows it
  // ("Passed", then the counts, #4502).
  test('on a phone the word stays with the counts', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);

    await expect(
      pill(page, 'Clean run').locator('.ci-seg-label'),
    ).toBeVisible();
    await expect(pill(page, 'Mixed run').locator('.ci-word')).toBeVisible();
    await expect(segments(page, 'Mixed run')).toHaveText(['8', '1', '2', '3']);
  });

  test('on a phone a failed pill still going keeps its running marker, one that is done has none', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page);
    const live = (title: string) => pill(page, title).locator('.ci-live');

    await expect(live('Mixed run')).toBeVisible();
    await expect(live('Mixed run').locator('.check-glyph-arc')).toBeVisible();
    await expect(live('Lone fail')).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect(live('Mixed run').locator('.check-glyph-arc')).toBeHidden();
    await expect(live('Mixed run').locator('.check-glyph-clock')).toBeVisible();
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
});

// A pill with every count at two digits is wider than the status track of a
// tablet-width list, and ran over the arrow at the end of the row (#5118).
// https://github.com/alrayyes/forge-dashboard/issues/5118
test.describe('A long pill leaves the row arrow clear (#5118)', () => {
  const LONG = pr(1, 'Long run', 'failure', {
    passed: 33,
    skipped: 11,
    running: 12,
    waiting: 13,
    notStarted: 14,
    failed: 15,
    unknown: 16,
    cancelled: 17,
    held: 18,
  } as Counts);
  const COUNTS = ['22', '11', '12', '13', '14', '15', '16', '17', '18'];

  // What is wrong with the row's layout, read in one go; nothing when sound.
  const faults = (page: Page) =>
    page.locator('#pr-rows > .row').evaluate((row) => {
      const pill = row.querySelector('.ci-pill');
      const arrow = row.querySelector('.go');
      if (!pill || !arrow) return ['no pill or arrow'];
      const p = pill.getBoundingClientRect();
      const a = arrow.getBoundingClientRect();
      if (!p.width || !a.width) return ['not laid out'];
      const found: string[] = [];
      if (
        p.right > a.left &&
        p.left < a.right &&
        p.bottom > a.top &&
        p.top < a.bottom
      )
        found.push(`pill ends at ${p.right}, arrow starts at ${a.left}`);
      for (const seg of pill.querySelectorAll('.ci-seg:not(.ci-seg-label)')) {
        const s = seg.getBoundingClientRect();
        if (
          !s.width ||
          s.left < p.left - 0.5 ||
          s.right > p.right + 0.5 ||
          s.top < p.top - 0.5 ||
          s.bottom > p.bottom + 0.5
        )
          found.push(`count ${seg.textContent} is clipped`);
      }
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth)
        found.push('page scrolls sideways');
      return found;
    });

  // 761 to 860px has the narrowest status track, 861 to 1190px the wider one.
  for (const width of [390, 761, 820, 860, 900, 1103, 1280]) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, [LONG]);

      await expect(segments(page, 'Long run')).toHaveText(COUNTS);
      await expect.poll(() => faults(page)).toEqual([]);
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations at 820px, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 820, height: 900 });
      await open(page, [LONG]);
      await expect(segments(page, 'Long run')).toHaveText(COUNTS);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
