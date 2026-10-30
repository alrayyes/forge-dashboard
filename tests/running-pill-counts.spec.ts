import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Running pill says how far a pipeline is: the word, then a count for each
// state that has any, each with its own glyph (#2004). The server tallies the
// counts, so the page is fed them here and only has to draw them.
// https://github.com/alrayyes/forge-dashboard/issues/2004

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
  pr(1, 'Early', 'pending', { passed: 0, running: 1, waiting: 8, failed: 0 }),
  pr(2, 'Mid', 'pending', { passed: 5, running: 2, waiting: 3, failed: 0 }),
  pr(3, 'Single', 'pending', { passed: 0, running: 1, waiting: 0, failed: 0 }),
  pr(4, 'No counts', 'pending'),
  pr(5, 'Done', 'success'),
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

test.describe('Running pill counts (#2004)', () => {
  test('a running pull request draws a count per state that has any, in order', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'Mid')).toHaveClass(/segmented/);
    await expect(pill(page, 'Mid').locator('.ci-seg-label')).toHaveText(
      'Running',
    );
    await expect(segments(page, 'Mid')).toHaveText(['5', '2', '3']);
    await expect(
      segments(page, 'Mid').evaluateAll((els) =>
        els.map((e) => e.className.replace('ci-seg ', '')),
      ),
    ).resolves.toEqual(['ci-seg-passed', 'ci-seg-running', 'ci-seg-waiting']);
  });

  test('a zero is never drawn', async ({ page }) => {
    await open(page);

    await expect(segments(page, 'Early')).toHaveText(['1', '8']);
    await expect(pill(page, 'Early').locator('.ci-seg-passed')).toHaveCount(0);
    await expect(segments(page, 'Single')).toHaveText(['1']);
  });

  test('each count has its own glyph, so colour is never alone', async ({
    page,
  }) => {
    await open(page);

    const glyphs = pill(page, 'Mid').locator('.check-glyph');
    await expect(glyphs.first()).toHaveAttribute('data-glyph', 'check');
    await expect(
      pill(page, 'Mid').locator('.ci-seg-waiting .check-glyph'),
    ).toHaveAttribute('data-glyph', 'hourglass');
  });

  test('the name says the counts in words and starts with the visible word', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'Mid')).toHaveAttribute(
      'aria-label',
      'Running 5 2 3: 5 passed, 2 running, 3 waiting. Open pipeline',
    );
  });

  test('a pull request without counts, or one that has none, keeps the plain pill', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'No counts')).not.toHaveClass(/segmented/);
    await expect(pill(page, 'No counts')).toHaveText('Running');
    await expect(pill(page, 'Done')).not.toHaveClass(/segmented/);
    await expect(pill(page, 'Done')).toHaveText('Passed');
  });

  test('on a phone the word goes, the counts stay, and the target is 44px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);

    await expect(pill(page, 'Mid').locator('.ci-seg-label')).toBeHidden();
    await expect(segments(page, 'Mid')).toHaveText(['5', '2', '3']);
    const box = await pill(page, 'Mid').boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    // The pill fits its slot, so the title keeps its room.
    const slot = await page
      .locator('#pr-rows > .row', { hasText: 'Mid' })
      .locator('.ci-slot')
      .boundingBox();
    expect(box?.width).toBeLessThanOrEqual((slot?.width ?? 0) + 1);
  });

  test('on a desktop the four counts fit beside the word', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);

    const el = pill(page, 'Mid');
    await expect(el).toBeVisible();
    const fits = await el.evaluate((e) => e.scrollWidth <= e.clientWidth);
    expect(fits).toBe(true);
  });

  test('in the dialog header a screen reader hears the pill once', async ({
    page,
  }) => {
    await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          description: null,
          comments: [],
          commentCount: 0,
          commentsTruncated: false,
          releaseNotes: null,
        }),
      }),
    );
    await open(page);
    await page
      .locator('#pr-rows > .row', { hasText: 'Mid' })
      .getByRole('button', { name: /^#\d+ / })
      .click();
    const badge = page
      .getByRole('dialog', { name: /^Pull request details/ })
      .locator('.details-state .ci-pill');
    await expect(badge).toBeVisible();

    // What a screen reader reads is the text outside anything aria-hidden.
    const heard = await badge.evaluate((root) => {
      const read = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
        if (!(node instanceof Element)) return '';
        if (node.getAttribute('aria-hidden') === 'true') return '';
        return [...node.childNodes].map(read).join('');
      };
      return read(root).replace(/\s+/g, ' ').trim();
    });
    expect(heard).toBe('Running 5 2 3: 5 passed, 2 running, 3 waiting');
  });

  test('with reduced motion the spinner gives way to the still clock', async ({
    page,
  }) => {
    await open(page);
    const arc = pill(page, 'Mid').locator('.ci-seg-running .check-glyph-arc');
    const clock = pill(page, 'Mid').locator(
      '.ci-seg-running .check-glyph-clock',
    );
    await expect(arc).toBeVisible();
    await expect(clock).toBeHidden();

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
