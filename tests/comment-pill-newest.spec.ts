import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';
import { settle } from './settle-helper';

// The row's comment pill opens the pull request dialog at the newest comment
// (#5002). Every other way in keeps opening it at the top.

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

async function mockDashboard(page: Page, conversationComments = 12) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/forge-dashboard',
            number: 42,
            title: 'Add structured logging',
            url: 'https://example.com/42',
            author: 'ryankes',
            draft: false,
            ci: 'success',
            labels: [],
            createdAt: ago(60),
            updatedAt: ago(5),
            mergeStatus: 'mergeable',
            behind: false,
            kind: 'regular',
            conversationComments,
          },
        ],
        issues: [],
      },
    }),
  );
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
