import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The pill on a pull request row that closes an issue, and the pill on an
// issue row that a pull request will close, open that item's dialog where the
// reader is. They do not load the other page first. Mocks /api/dashboard and
// the details endpoints only and writes no per-user state, so it starts from
// the shared session.
// https://github.com/alrayyes/forge-dashboard/issues/2146
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const REPO = 'alrayyes/forge-dashboard';

const closing = (number: number, repo = REPO) => ({
  repo,
  number,
  url: `https://example.com/${repo}/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${repo}/${number}`,
});

const linked = (number: number, repo = REPO) => ({
  forge: 'github',
  repo,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${repo}/${number}`,
});

const issue = (number: number, linkedPullRequests: unknown[] = []) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests,
});

const pullRequest = (
  number: number,
  closesIssues: unknown[] = [],
  overrides: Record<string, unknown> = {},
) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Pull request ${number}`,
  url: `https://example.com/pull/${number}`,
  author: 'ryankes',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
  closesIssues,
  ...overrides,
});

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = (text: string) => ({
  description: {
    text,
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
});

type Board = { shown?: unknown[]; everything?: unknown[]; issues?: unknown[] };

async function mockBoard(page: Page, board: Board, issueStatus = 200) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) => {
    const all = route.request().url().includes('includeHidden=true');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: all
          ? (board.everything ?? board.shown ?? [])
          : (board.shown ?? []),
        issues: board.issues ?? [],
      }),
    });
  });
  await page.route('**/api/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(details('The **pull request** text.')),
    }),
  );
  await page.route('**/api/issues/details*', (route: Route) =>
    issueStatus === 200
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(details('The **issue** text.')),
        })
      : route.fulfill({
          status: issueStatus,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'not found' }),
        }),
  );
}

const closingPill = (page: Page, number: number) =>
  page
    .locator('#pr-rows .row', { hasText: `Pull request ${number}` })
    .locator('.closing-issue');
const linkedPill = (page: Page, number: number) =>
  page
    .locator('#issue-rows .row', { hasText: `Issue ${number}` })
    .locator('.linked-pr');
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const pullDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });

const axeClean = async (page: Page, label: string) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, label).toEqual([]);
};

test.describe('a closing-issue pill on the Pull requests page', () => {
  test('opens the issue dialog on that page, and Escape returns focus to the pill', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(1, [closing(12)])],
      issues: [issue(12)],
    });
    await page.goto('/pull-requests.html');

    const pill = closingPill(page, 1);
    await expect(pill).toHaveAccessibleName('Closes #12, opens the issue');
    await pill.click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toHaveAccessibleName(
      `Issue details: ${REPO} #12`,
    );
    await expect(issueDialog(page).locator('strong')).toHaveText('issue');
    expect(new URL(page.url()).pathname).toBe('/pull-requests.html');
    expect(new URL(page.url()).search).toBe('');

    await page.keyboard.press('Escape');

    await expect(issueDialog(page)).toBeHidden();
    await expect(pill).toBeFocused();
  });

  test('opens for an issue the board does not list, with a link to its forge', async ({
    page,
  }) => {
    await mockBoard(page, { shown: [pullRequest(1, [closing(99)])] });
    await page.goto('/pull-requests.html');

    await closingPill(page, 1).click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page).locator('strong')).toHaveText('issue');
    await expect(
      issueDialog(page)
        .locator(`a[href="${closing(99).url}"]`)
        .first(),
    ).toBeVisible();
  });

  test('says so in the dialog when the forge no longer has the issue', async ({
    page,
  }) => {
    await mockBoard(page, { shown: [pullRequest(1, [closing(99)])] }, 404);
    await page.goto('/pull-requests.html');

    await closingPill(page, 1).click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toContainText('Could not load the details');
  });

  test('has no axe violations with the dialog open, in light, dark and at 390 px', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(1, [closing(12)])],
      issues: [issue(12)],
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/pull-requests.html');
        await closingPill(page, 1).click();
        await expect(issueDialog(page).locator('strong')).toHaveText('issue');
        await axeClean(page, `${scheme} at ${width}px`);
      }
    }
  });
});

test.describe('a linked pull request pill on the Issues page', () => {
  test('opens the pull request dialog on that page, and Escape returns focus to the pill', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(12)],
      issues: [issue(1, [linked(12)])],
    });
    await page.goto('/issues.html');

    const pill = linkedPill(page, 1);
    await expect(pill).toHaveAccessibleName(
      'Pull request #12 open, closes this issue',
    );
    await pill.click();

    await expect(pullDialog(page)).toBeVisible();
    await expect(pullDialog(page)).toHaveAccessibleName(
      `Pull request details: ${REPO} #12`,
    );
    await expect(pullDialog(page).locator('strong')).toHaveText('pull request');
    expect(new URL(page.url()).pathname).toBe('/issues.html');
    expect(new URL(page.url()).search).toBe('');

    await page.keyboard.press('Escape');

    await expect(pullDialog(page)).toBeHidden();
    await expect(pill).toBeFocused();
  });

  test('opens a pull request the Issues page does not list, such as a bot or a draft', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [],
      everything: [pullRequest(12, [], { draft: true })],
      issues: [issue(1, [linked(12)])],
    });
    await page.goto('/issues.html');

    await linkedPill(page, 1).click();

    await expect(pullDialog(page)).toBeVisible();
    await expect(pullDialog(page).locator('strong')).toHaveText('pull request');
  });

  test('says plainly when the pull request is not found anywhere', async ({
    page,
  }) => {
    await mockBoard(page, { shown: [], issues: [issue(1, [linked(12)])] });
    await page.goto('/issues.html');

    await linkedPill(page, 1).click();

    await expect(pullDialog(page)).toBeHidden();
    await expect(page.locator('#issue-address-note')).toContainText(
      `${REPO} #12`,
    );
  });

  test('has no axe violations with the dialog open, in light, dark and at 390 px', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(12)],
      issues: [issue(1, [linked(12)])],
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/issues.html');
        await linkedPill(page, 1).click();
        await expect(pullDialog(page).locator('strong')).toHaveText(
          'pull request',
        );
        await axeClean(page, `${scheme} at ${width}px`);
      }
    }
  });
});

test.describe('the old addresses', () => {
  test('?issue= still opens the issue on the Issues page', async ({ page }) => {
    await mockBoard(page, { issues: [issue(12)] });
    await page.goto(`/issues.html?issue=github/${REPO}/12`);
    await expect(issueDialog(page)).toBeVisible();
  });

  test('?pr= still opens the pull request on its page', async ({ page }) => {
    await mockBoard(page, { shown: [pullRequest(12)] });
    await page.goto(`/pull-requests.html?pr=github/${REPO}/12`);
    await expect(pullDialog(page)).toBeVisible();
  });
});
