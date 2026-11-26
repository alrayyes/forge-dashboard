import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';
import { settle } from './settle-helper';

// The row's comment pill opens the pull request dialog at the newest comment
// (#5002). No other way in jumps to a comment.

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

function body(text: string) {
  return {
    text,
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  };
}

function comments(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    ...body(`Comment number ${i + 1}.`),
    id: `c${i + 1}`,
    author: { login: 'alice', avatarUrl: '', url: '' },
    createdAt: ago(n - i),
    updatedAt: null,
  }));
}

function details(n: number, total = n) {
  return {
    description: body('A description.\n\n'.repeat(20)),
    comments: comments(n),
    commentCount: total,
    commentsTruncated: total > n,
    releaseNotes: null,
  };
}

const LONG_TITLE =
  'Add structured logging to every handler, the aggregator and both forge clients so a failed refresh can be traced end to end';
const FIVE_LABELS = [
  'enhancement',
  'dependencies',
  'needs-review',
  'breaking-change',
  'documentation',
].map((name) => ({ name, color: '0e8a16' }));

// `polls` reads the board every second, and `touch` makes the next read say the
// pull request changed, which is what reloads an open dialog.
async function mockDashboard(
  page: Page,
  conversationComments = 12,
  { polls = false, crowded = false } = {},
) {
  let updatedAt = ago(5);
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        ...(polls ? { readIntervalSeconds: 1 } : {}),
        forges: [forgeHealth('github')],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/forge-dashboard',
            number: 42,
            title: crowded ? LONG_TITLE : 'Add structured logging',
            url: 'https://example.com/42',
            author: 'ryankes',
            draft: false,
            ci: 'success',
            labels: crowded ? FIVE_LABELS : [],
            createdAt: ago(60),
            updatedAt,
            mergeStatus: crowded ? 'conflicting' : 'mergeable',
            behind: crowded,
            kind: 'regular',
            conversationComments,
          },
        ],
        issues: [],
      },
    }),
  );
  return {
    touch: () => {
      updatedAt = new Date().toISOString();
    },
  };
}

// Answers each read with what `answer` says then; `hold` keeps reads waiting
// until `release` is called.
async function mockDetails(
  page: Page,
  answer: () => { status?: number; json: unknown },
  { hold = false } = {},
) {
  let release = () => {};
  const gate = hold
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  await page.route('**/api/v1/pull-requests/details*', async (route) => {
    await gate;
    await route.fulfill(answer());
  });
  return { release: () => release() };
}

const pill = (page: Page) => page.locator('#pr-rows .row .review-pill');
const title = (page: Page) =>
  page.locator('#pr-rows .row').getByRole('button', { name: /^#42 / });
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const items = (page: Page) => dialog(page).locator('.details-comment');
const scrollTop = (page: Page) =>
  dialog(page)
    .locator('.details-body')
    .evaluate((el) => el.scrollTop);

async function expectLandedOn(page: Page, text: string) {
  const newest = items(page).last();
  await expect(newest).toContainText(text);
  await expect(newest).toBeFocused();
  await expect(newest).toBeInViewport({ ratio: 1 });
  // The header stays where it was: only the dialog's body scrolled.
  await expect(
    dialog(page).getByRole('heading', { name: 'Add structured logging' }),
  ).toBeInViewport();
}

async function expectAtTop(page: Page) {
  await settle(page);
  expect(await scrollTop(page)).toBe(0);
  await expect(dialog(page).locator('.details-comment:focus')).toHaveCount(0);
  await expect(dialog(page).locator('.details-comment[tabindex]')).toHaveCount(
    0,
  );
}

async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('the comment pill opens the dialog at the newest comment', () => {
  test('by mouse, in light and dark at 360, 390 and 1280px, with Escape back to the pill', async ({
    page,
  }) => {
    await mockDashboard(page);
    await mockDetails(page, () => ({ json: details(12) }));
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [360, 390, 1280]) {
        await test.step(`${scheme} ${width}px`, async () => {
          await page.emulateMedia({ colorScheme: scheme });
          await page.setViewportSize({ width, height: 800 });
          await page.goto('/pull-requests.html');

          await pill(page).click();

          await expectLandedOn(page, 'Comment number 12.');
          await expect(items(page).last()).toHaveCSS('outline-style', 'solid');
          await scan(page);
          await page.keyboard.press('Escape');
          await expect(dialog(page)).toBeHidden();
          await expect(pill(page)).toBeFocused();
        });
      }
    }
  });

  test('by keyboard', async ({ page }) => {
    await mockDashboard(page);
    await mockDetails(page, () => ({ json: details(12) }));
    await page.goto('/pull-requests.html');

    await pill(page).press('Enter');

    await expectLandedOn(page, 'Comment number 12.');
    await page.keyboard.press('Escape');
    await expect(pill(page)).toBeFocused();
  });

  test('lands on the newest listed comment of a cut-off thread, with the note in view', async ({
    page,
  }) => {
    await mockDashboard(page, 80);
    await mockDetails(page, () => ({ json: details(50, 80) }));
    await page.goto('/pull-requests.html');

    await pill(page).click();

    await expectLandedOn(page, 'Comment number 50.');
    await expect(
      dialog(page).getByText('Showing the first 50 of 80 comments.'),
    ).toBeInViewport();
  });

  test('jumps there at once under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Every position the dialog's body is ever scrolled to.
    await page.addInitScript(() => {
      const seen: number[] = [];
      Object.assign(window, { seenScrolls: seen });
      document.addEventListener(
        'scroll',
        (event) => {
          const el = event.target as Element;
          if (el.classList?.contains('details-body')) seen.push(el.scrollTop);
        },
        true,
      );
    });
    await mockDashboard(page);
    await mockDetails(page, () => ({ json: details(12) }));
    await page.goto('/pull-requests.html');

    await pill(page).click();

    await expectLandedOn(page, 'Comment number 12.');
    await settle(page);
    const end = await scrollTop(page);
    const seen = await page.evaluate(
      () => (window as unknown as { seenScrolls: number[] }).seenScrolls,
    );
    expect(end).toBeGreaterThan(0);
    // An animated scroll passes through positions on the way.
    expect(new Set(seen)).toEqual(new Set([end]));
  });

  test('lands once comments that were still loading arrive', async ({
    page,
  }) => {
    await mockDashboard(page);
    const reads = await mockDetails(page, () => ({ json: details(12) }), {
      hold: true,
    });
    await page.goto('/pull-requests.html');

    await pill(page).click();
    await expect(dialog(page).getByText('Loading details')).toBeAttached();
    reads.release();

    await expectLandedOn(page, 'Comment number 12.');
  });

  test('leaves a reader who moved on while the comments loaded where they are', async ({
    page,
  }) => {
    await mockDashboard(page);
    const reads = await mockDetails(page, () => ({ json: details(12) }), {
      hold: true,
    });
    await page.goto('/pull-requests.html');

    await pill(page).click();
    const close = dialog(page).getByRole('button', { name: 'Close' }).first();
    await close.focus();
    reads.release();

    await expect(items(page)).toHaveCount(12);
    await settle(page);
    await expect(close).toBeFocused();
    expect(await scrollTop(page)).toBe(0);
  });

  test('moves on to a comment that is newer than the remembered ones', async ({
    page,
  }) => {
    await mockDashboard(page);
    let count = 11;
    await mockDetails(page, () => ({ json: details(count) }));
    await page.goto('/pull-requests.html');
    await title(page).click();
    await expect(items(page)).toHaveCount(11);
    await page.keyboard.press('Escape');
    count = 12;

    await pill(page).click();

    await expect(items(page)).toHaveCount(12);
    await expectLandedOn(page, 'Comment number 12.');
  });

  test('stays at the top when the comments fail to load, and lands after a retry', async ({
    page,
  }) => {
    await mockDashboard(page);
    let failing = true;
    await mockDetails(page, () =>
      failing
        ? { status: 502, json: { error: 'the forge is unreachable' } }
        : { json: details(12) },
    );
    await page.goto('/pull-requests.html');

    await pill(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText(
      'the forge is unreachable',
    );
    await scan(page);
    await page.keyboard.press('Escape');
    await expect(pill(page)).toBeFocused();

    await pill(page).click();
    await expect(dialog(page).getByRole('alert')).toBeVisible();
    failing = false;
    await dialog(page).getByRole('button', { name: 'Try again' }).click();

    await expectLandedOn(page, 'Comment number 12.');
  });

  // The pill counts review comments on lines of code too, which the dialog
  // doesn't list, so a row with a pill can have an empty conversation.
  test('opens as usual when there is no comment to land on', async ({
    page,
  }) => {
    await mockDashboard(page, 3);
    await mockDetails(page, () => ({ json: details(0) }));
    await page.goto('/pull-requests.html');

    await pill(page).click();

    await expect(dialog(page).getByText('No comments.')).toBeVisible();
    await expectAtTop(page);
    await scan(page);
    await page.keyboard.press('Escape');
    await expect(pill(page)).toBeFocused();
  });

  test('stays put when a live update brings a newer comment after landing', async ({
    page,
  }) => {
    const board = await mockDashboard(page, 12, { polls: true });
    let count = 12;
    await mockDetails(page, () => ({ json: details(count) }));
    await page.goto('/pull-requests.html');
    await pill(page).click();
    await expectLandedOn(page, 'Comment number 12.');
    await settle(page);
    const top = await scrollTop(page);

    count = 13;
    board.touch();

    await expect(items(page)).toHaveCount(13);
    await settle(page);
    await expect(items(page).nth(11)).toBeFocused();
    expect(await scrollTop(page)).toBe(top);
  });

  test('stays put when the reader scrolled away before a newer comment arrived', async ({
    page,
  }) => {
    await mockDashboard(page);
    let count = 11;
    let gate = Promise.resolve();
    let release = () => {};
    await page.route('**/api/v1/pull-requests/details*', async (route) => {
      const answer = details(count);
      await gate;
      await route.fulfill({ json: answer });
    });
    await page.goto('/pull-requests.html');
    await title(page).click();
    await expect(items(page)).toHaveCount(11);
    await page.keyboard.press('Escape');
    count = 12;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await pill(page).click();
    await expectLandedOn(page, 'Comment number 11.');
    await dialog(page)
      .locator('.details-body')
      .evaluate((el) => {
        el.scrollTop = 0;
      });
    release();

    await expect(items(page)).toHaveCount(12);
    await settle(page);
    expect(await scrollTop(page)).toBe(0);
    await expect(items(page).last()).not.toBeFocused();
  });

  test('keeps the cut-off note in view under a comment taller than the dialog', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 700 });
    await mockDashboard(page, 80);
    const thread = details(50, 80);
    const tall = thread.comments.at(-1);
    if (tall)
      tall.text = `${'A long paragraph.\n\n'.repeat(60)}[the last link](https://example.com/last)`;
    await mockDetails(page, () => ({ json: thread }));
    await page.goto('/pull-requests.html');

    await pill(page).click();

    const newest = items(page).last();
    await expect(newest).toBeFocused();
    const note = dialog(page).getByText('Showing the first 50 of 80 comments.');
    await expect(note).toBeInViewport({ ratio: 1 });
    // On top of the comment, not under it.
    await note.getByRole('link').click({ trial: true });
    // The comment still starts at the top of the body.
    const body = await dialog(page).locator('.details-body').boundingBox();
    const box = await newest.boundingBox();
    const offset = (box?.y ?? Number.NaN) - (body?.y ?? Number.NaN);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(24);
    await scan(page);

    // A link in the comment, focused where the note was, is not under it.
    const covered = await newest
      .getByRole('link', { name: 'the last link' })
      .evaluate((link) => {
        const scroller = link.closest('.details-body') as HTMLElement;
        scroller.scrollTop +=
          link.getBoundingClientRect().bottom -
          scroller.getBoundingClientRect().bottom +
          24;
        (link as HTMLElement).focus({ preventScroll: true });
        const at = link.getBoundingClientRect();
        return (
          document.elementFromPoint(at.x + 2, at.y + at.height / 2) !== link
        );
      });
    expect(covered).toBe(false);
  });

  // A short window, where the dialog itself can't fit what it holds.
  test('keeps the header in place in a short landscape window', async ({
    page,
  }) => {
    await mockDashboard(page);
    await mockDetails(page, () => ({ json: details(12) }));
    for (const [width, height] of [
      [844, 390],
      [740, 320],
      [480, 270],
    ] as const) {
      await test.step(`${width}x${height}`, async () => {
        await page.setViewportSize({ width, height });
        await page.goto('/pull-requests.html');

        await pill(page).click();

        await expect(items(page).last()).toBeFocused();
        expect(await dialog(page).evaluate((el) => el.scrollTop)).toBe(0);
        await expect(
          dialog(page).getByRole('heading', { name: 'Add structured logging' }),
        ).toBeInViewport();
      });
    }
  });

  // A long title, five labels and a conflicting branch: the header takes so
  // much of a small landscape window that the body starts near its bottom edge
  // (#5018).
  const smallLandscape = [
    [568, 320],
    [740, 320],
    [480, 270],
  ] as const;

  for (const [width, height] of smallLandscape) {
    test(`shows the newest comment under a tall header at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mockDashboard(page, 12, { crowded: true });
      await mockDetails(page, () => ({ json: details(12) }));
      await page.goto('/pull-requests.html');

      await pill(page).click();

      const newest = items(page).last();
      await expect(newest).toBeFocused();
      await expect(newest).toBeInViewport({ ratio: 1 });
      await scan(page);
      await page.keyboard.press('Escape');
      await expect(pill(page)).toBeFocused();
    });

    test(`shows the cut-off note without covering a focused link at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mockDashboard(page, 80, { crowded: true });
      const thread = details(50, 80);
      const tall = thread.comments.at(-1);
      if (tall)
        tall.text = `${'A long paragraph.\n\n'.repeat(20)}[the last link](https://example.com/last)`;
      await mockDetails(page, () => ({ json: thread }));
      await page.goto('/pull-requests.html');

      await pill(page).click();

      await expect(items(page).last()).toBeFocused();
      await expect(items(page).last()).toBeInViewport();
      const note = dialog(page).getByText(
        'Showing the first 50 of 80 comments.',
      );
      // Not 1: the dialog's fractional position can clip under half a pixel.
      await expect(note).toBeInViewport({ ratio: 0.95 });
      await note.getByRole('link').click({ trial: true });
      await scan(page);

      const link = items(page)
        .last()
        .getByRole('link', { name: 'the last link' });
      await link.focus();
      await expect(link).toBeInViewport({ ratio: 1 });
      const covered = await link.evaluate((el) => {
        const at = el.getBoundingClientRect();
        return document.elementFromPoint(at.x + 2, at.y + at.height / 2) !== el;
      });
      expect(covered).toBe(false);
      // Off its pinned place, the note is still there to scroll to.
      await note.scrollIntoViewIfNeeded();
      await expect(note).toBeInViewport({ ratio: 0.95 });
    });
  }

  test('leaves a reader who scrolled the dialog while the comments loaded where they are', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 568, height: 320 });
    await mockDashboard(page, 12, { crowded: true });
    const reads = await mockDetails(page, () => ({ json: details(12) }), {
      hold: true,
    });
    await page.goto('/pull-requests.html');
    await pill(page).click();
    await expect(dialog(page).getByText('Loading details')).toBeAttached();
    const top = await dialog(page).evaluate((el) => {
      el.scrollTop = 20;
      return el.scrollTop;
    });

    reads.release();

    await expect(items(page)).toHaveCount(12);
    await settle(page);
    expect(await dialog(page).evaluate((el) => el.scrollTop)).toBe(top);
    expect(await scrollTop(page)).toBe(0);
  });

  test('does not jump later when a live update succeeds after a failed first read', async ({
    page,
  }) => {
    const board = await mockDashboard(page, 12, { polls: true });
    let failing = true;
    await mockDetails(page, () =>
      failing
        ? { status: 502, json: { error: 'the forge is unreachable' } }
        : { json: details(12) },
    );
    await page.goto('/pull-requests.html');
    await pill(page).click();
    await expect(dialog(page).getByRole('alert')).toBeVisible();

    failing = false;
    board.touch();

    await expect(items(page)).toHaveCount(12);
    await expectAtTop(page);
  });

  test('lands on a prefetched comment when the read for this open fails', async ({
    page,
  }) => {
    await mockDashboard(page);
    let failing = false;
    await mockDetails(page, () =>
      failing
        ? { status: 502, json: { error: 'the forge is unreachable' } }
        : { json: details(12) },
    );
    await page.goto('/pull-requests.html');
    await Promise.all([
      page.waitForResponse(/pull-requests\/details/),
      title(page).hover(),
    ]);
    failing = true;
    // Holds the scripts not loaded yet, the markdown renderer among them, so
    // the read has failed before the prefetched answer is on screen.
    await page.route('**/_app/immutable/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    await pill(page).click();

    await expect(dialog(page).getByText('may be out of date')).toBeVisible();
    await expectLandedOn(page, 'Comment number 12.');
  });

  test('lands again after the reader scrolled away and closed', async ({
    page,
  }) => {
    await mockDashboard(page);
    await mockDetails(page, () => ({ json: details(12) }));
    await page.goto('/pull-requests.html');
    await title(page).click();
    await expect(items(page)).toHaveCount(12);
    await items(page).nth(5).scrollIntoViewIfNeeded();
    await page.keyboard.press('Escape');

    await pill(page).click();

    await expectLandedOn(page, 'Comment number 12.');
  });

  test('is the only way in that scrolls: the title opens at the top, even after the pill', async ({
    page,
  }) => {
    await mockDashboard(page);
    await mockDetails(page, () => ({ json: details(12) }));
    await page.goto('/pull-requests.html');
    await pill(page).click();
    await expectLandedOn(page, 'Comment number 12.');
    await page.keyboard.press('Escape');

    await title(page).click();

    await expect(items(page)).toHaveCount(12);
    await expectAtTop(page);
  });
});
