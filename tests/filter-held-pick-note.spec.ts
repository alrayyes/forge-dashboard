import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1620: a saved pick the page you are on does not offer is kept for the page
// that does, so it has to be said out loud, with a way to drop it. The saved
// state is per user, so this spec registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/1620

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [{ name: 'chore', color: '0e8a16' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    ...overrides,
  };
}

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'ryan',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Authors, labels and repos that only one page has: ryan, bug and acme/docs
// are on Issues only; claude, chore and acme/infra on Pull requests only (the
// bot's pull request belongs to the Bots page).
const PRS = [
  pr(1),
  pr(2, { repo: 'acme/infra', author: 'dana', title: 'Pull request two' }),
  pr(3, { author: 'renovate[bot]', labels: [] }),
];
const ISSUES = [
  issue(1),
  issue(2, {
    repo: 'acme/docs',
    author: 'sam',
    labels: [{ name: 'docs', color: '0366d6' }],
  }),
  issue(3, { author: 'ryan', labels: [] }),
];

async function open(page: Page, url: string) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 3 }],
        pullRequests: PRS,
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto(url);
}

const issueRows = (page: Page) => page.locator('#issue-rows > .row');
const prRows = (page: Page) => page.locator('#pr-rows > .row');
const nav = (page: Page, name: string) =>
  page.locator(`.app-nav a[href="/${name}.html"]`);

// Seeds the saved copy and waits until the server reports it, so the page
// opened next reads the seed and not an older write.
async function seed(
  page: Page,
  shared: Record<string, string>,
  pr: Record<string, string> = {},
) {
  await page.request.put('/api/settings/filter-state', {
    data: { shared, pr, issue: {}, view: {} },
  });
  await expect
    .poll(async () => {
      const got = await (
        await page.request.get('/api/settings/filter-state')
      ).json();
      return JSON.stringify([got?.shared ?? {}, got?.pr ?? {}]);
    })
    .toBe(JSON.stringify([shared, pr]));
}

test.describe('a saved pick the page does not offer is visible (#1620)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `held-pick-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Held Pick',
    );
    await open(page, '/issues.html');
    await expect(issueRows(page)).toHaveCount(3);
    await page.locator('#shared-author-select').selectOption('ryan');
    await expect(issueRows(page)).toHaveCount(2);
    await nav(page, 'pull-requests').click();
    await expect(prRows(page)).toHaveCount(2);
    // The page's own save has to land before a test seeds the server, or the
    // older write can arrive last and undo the seed.
    await expect.poll(() => savedAuthor(page)).toBe('ryan');
  });

  const note = (page: Page) =>
    page
      .locator('#held-picks')
      .getByText('Saved author "ryan" is not on this page.');
  // An emptied copy may have no "shared" at all, so a missing one reads as ''.
  const savedAuthor = async (page: Page) =>
    (await (await page.request.get('/api/settings/filter-state')).json())
      ?.shared?.author ?? '';

  test('says the pick is waiting and offers Clear filters', async ({
    page,
  }) => {
    await expect(note(page)).toBeVisible();
    await expect(page.locator('#shared-author-select')).toHaveValue('');
    await expect(page.locator('#clear-filters-button')).toBeEnabled();
    await expect.poll(() => savedAuthor(page)).toBe('ryan');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('Clear filters drops the pick from the note and the saved copy', async ({
    page,
  }) => {
    await expect(note(page)).toBeVisible();
    await page.locator('#clear-filters-button').click();

    await expect(note(page)).toHaveCount(0);
    await expect(page.locator('#clear-filters-button')).toBeDisabled();
    await expect.poll(() => savedAuthor(page)).toBe('');

    await nav(page, 'issues').click();
    await expect(issueRows(page)).toHaveCount(3);
    await expect(page.locator('#shared-author-select')).toHaveValue('');
  });

  test('the note has its own button that names what it removes', async ({
    page,
  }) => {
    const button = page.getByRole('button', {
      name: 'Clear saved author "ryan"',
    });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await button.click();

    await expect(note(page)).toHaveCount(0);
    await expect(page.locator('#clear-filters-button')).toBeDisabled();
    await expect.poll(() => savedAuthor(page)).toBe('');
  });

  test('fits a 360px phone without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(note(page)).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('is readable in the dark colour scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(note(page)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

// These seed the saved copy directly, so they register without holding a pick
// first: an earlier page's own save could otherwise land after the seed.
test.describe('seeded saved picks (#1620)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerViaInvite(
      page,
      request,
      baseURL,
      `held-seeded-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Held Seeded',
    );
  });

  test('a 300-character value does not push the page sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await seed(page, { author: 'a'.repeat(300) });
    await open(page, '/pull-requests.html');
    await expect(prRows(page)).toHaveCount(2);

    const clear = page.locator('#held-picks .held-pick-clear');
    await expect(clear).toBeVisible();
    await expect(page.locator('#held-picks')).toContainText('…');
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await clear.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  });

  test('names a CI pick as a filter', async ({ page }) => {
    await seed(page, {}, { status: 'failure' });
    await open(page, '/pull-requests.html');
    await expect(prRows(page)).toHaveCount(2);
    await expect(page.locator('#held-picks')).toHaveText(
      /Saved filter "CI status: Failing" is not on this page\./,
    );
  });

  test('after a Clear, focus moves to the next Clear button, then to the note', async ({
    page,
  }) => {
    await seed(page, { author: 'ryan', label: 'bug' });
    await open(page, '/pull-requests.html');
    const clears = page.locator('#held-picks .held-pick-clear');
    await expect(clears).toHaveCount(2);

    await page
      .getByRole('button', { name: 'Clear saved author "ryan"' })
      .click();
    await expect(clears).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Clear saved label "bug"' }),
    ).toBeFocused();

    await page.getByRole('button', { name: 'Clear saved label "bug"' }).click();
    await expect(clears).toHaveCount(0);
    await expect(page.locator('#held-picks')).toBeFocused();
  });

  test('clearing one pick leaves the other line untouched', async ({
    page,
  }) => {
    await seed(page, { author: 'ryan', label: 'bug' });
    await open(page, '/pull-requests.html');
    const labelLine = page.locator('#held-picks .held-pick', {
      hasText: 'label',
    });
    await expect(labelLine).toBeVisible();
    await labelLine.evaluate((n) => {
      (n as HTMLElement).dataset.kept = 'yes';
    });
    await page
      .getByRole('button', { name: 'Clear saved author "ryan"' })
      .click();
    await expect(page.locator('#held-picks .held-pick')).toHaveCount(1);
    await expect(labelLine).toHaveAttribute('data-kept', 'yes');
  });
});
