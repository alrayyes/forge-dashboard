import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// #1335: every pull request row says how many review comments it has and how
// many review threads are still open. The server counts them (`reviewComments`,
// `unresolvedThreads`, #1360); the page only reads them. Zero draws nothing,
// and a forge that can't say which threads are open (`unresolvedThreads`
// null, Forgejo) shows the count without the amber state.
// https://github.com/alrayyes/forge-dashboard/issues/1335

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    allowedActions: [{ action: 'merge' }, { action: 'close' }],
    reviewComments: 0,
    unresolvedThreads: 0,
    ...overrides,
  };
}

const PRS = [
  makePR(7, { title: 'None', reviewComments: 0, unresolvedThreads: 0 }),
  makePR(6, { title: 'Resolved', reviewComments: 7, unresolvedThreads: 0 }),
  makePR(5, { title: 'Open', reviewComments: 7, unresolvedThreads: 2 }),
  makePR(4, { title: 'Busy', reviewComments: 128, unresolvedThreads: 24 }),
  makePR(3, {
    title: 'Forgejo',
    forge: 'forgejo',
    repo: 'ryan/infra',
    url: 'https://git.example.com/ryan/infra/pulls/3',
    reviewComments: 4,
    unresolvedThreads: null,
  }),
  makePR(2, { title: 'Old server', reviewComments: undefined }),
  makePR(1, { title: 'Single', reviewComments: 1, unresolvedThreads: 1 }),
];

async function open(page: Page, scheme: 'light' | 'dark' = 'light') {
  await page.emulateMedia({ colorScheme: scheme });
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests: PRS,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row').filter({
    has: page.locator('.title-text', { hasText: new RegExp(`\\d${title}$`) }),
  });
const pill = (page: Page, title: string) =>
  row(page, title).locator('.review-pill');
const shown = (page: Page, title: string) =>
  pill(page, title).locator('.review-pill-text');

test.describe('the review comments pill (#1335)', () => {
  // Writes nothing per user, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('draws nothing at zero comments, and nothing when the server sends no count', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'None')).toHaveCount(0);
    await expect(pill(page, 'Old server')).toHaveCount(0);
    await expect(page.locator('#pr-rows')).not.toContainText(/\b0 review/);
  });

  test('every thread resolved is a quiet pill with the count, named for what it counts', async ({
    page,
  }) => {
    await open(page);

    const p = pill(page, 'Resolved');
    await expect(shown(page, 'Resolved')).toHaveText('7');
    await expect(p).toHaveAccessibleName('7 review comments');
    await expect(p).not.toHaveClass(/\bopen\b/);
    await expect(p.locator('.dot')).toHaveCount(0);
  });

  test('open threads turn it amber and say how many', async ({ page }) => {
    await open(page);

    const p = pill(page, 'Open');
    await expect(shown(page, 'Open')).toHaveText('7 · 2 open');
    await expect(p).toHaveAccessibleName(
      '7 review comments, 2 unresolved threads',
    );
    await expect(p).toHaveClass(/\bopen\b/);
    // The state is a dot and a different background, not only a class name.
    await expect(p.locator('.dot')).toHaveCount(1);
    const background = (title: string) =>
      pill(page, title).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await background('Open')).not.toBe(await background('Resolved'));
  });

  test('a lone comment and a lone open thread read in the singular', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'Single')).toHaveAccessibleName(
      '1 review comment, 1 unresolved thread',
    );
  });

  test('a forge that cannot say which threads are open shows the count and no amber', async ({
    page,
  }) => {
    await open(page);

    const p = pill(page, 'Forgejo');
    await expect(shown(page, 'Forgejo')).toHaveText('4');
    await expect(p).toHaveAccessibleName('4 review comments');
    await expect(p).not.toHaveClass(/\bopen\b/);
  });

  test('opens the files and review view on the forge in a new tab', async ({
    page,
  }) => {
    await open(page);

    const github = pill(page, 'Open');
    await expect(github).toHaveAttribute(
      'href',
      'https://example.com/pull/5/files',
    );
    await expect(github).toHaveAttribute('target', '_blank');
    await expect(github).toHaveAttribute('rel', /noopener/);
    await expect(pill(page, 'Forgejo')).toHaveAttribute(
      'href',
      'https://git.example.com/ryan/infra/pulls/3/files',
    );

    await github.focus();
    const ring = await github.evaluate(
      (el) => getComputedStyle(el).outlineStyle,
    );
    expect(ring).not.toBe('none');
  });

  test('128 comments and 24 open stay on one line without breaking the row', async ({
    page,
  }) => {
    await open(page);

    const p = pill(page, 'Busy');
    await expect(shown(page, 'Busy')).toHaveText('128 · 24 open');
    // One client rect per line box of the visible text.
    const lines = await shown(page, 'Busy').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    });
    expect(lines).toBe(1);
    await expect(p).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe-core violations in the ${scheme} theme`, async ({
      page,
    }) => {
      await open(page, scheme);
      await expect(pill(page, 'Open')).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('on a 360px phone the pill is a 44px target, inside the card, with no axe violations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page);

    const p = pill(page, 'Busy');
    await expect(p).toBeVisible();
    const box = await p.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    const card = await row(page, 'Busy').boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (card?.x ?? 0) + (card?.width ?? 0) + 1,
    );

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
