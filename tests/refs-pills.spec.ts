import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A pull request that only references a ticket (Refs #N) shows a refs pill on
// its row, apart from the closes pill, and the pill opens that ticket's dialog
// in place. Mocks /api/v1/dashboard and the details endpoints only.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const REPO = 'alrayyes/forge-dashboard';

const link = (
  number: number,
  relation: 'closes' | 'refs',
  repo = REPO,
  tracked = true,
) => ({
  repo,
  number,
  relation,
  tracked,
  url: `https://example.com/${repo}/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${repo}/${number}`,
});

const issue = (number: number) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests: [],
});

const pullRequest = (
  number: number,
  closesIssues: unknown[],
  refsIssues: unknown[],
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
  refsIssues,
  mentionsIssues: [],
});

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'The **issue** text.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
};

async function mockBoard(
  page: Page,
  board: { pullRequests: unknown[]; issues?: unknown[] },
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: board.pullRequests,
        issues: board.issues ?? [],
      }),
    }),
  );
  for (const endpoint of ['pull-requests', 'issues'])
    await page.route(`**/api/v1/${endpoint}/details*`, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(details),
      }),
    );
}

const row = (page: Page, number: number) =>
  page.locator('#pr-rows .row', { hasText: `Pull request ${number}` });
const refs = (page: Page, number: number) =>
  row(page, number).locator('.refs-issue');
const closes = (page: Page, number: number) =>
  row(page, number).locator('.closing-issue');

test.describe('the refs pill on a pull request row', () => {
  test('is worded Refs, apart from the closes pill, and named for a screen reader', async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [
        pullRequest(1, [link(10, 'closes')], [link(12, 'refs')]),
        pullRequest(2, [], []),
      ],
    });
    await page.goto('/pull-requests.html');

    await expect(refs(page, 1)).toHaveText('Refs #12');
    await expect(refs(page, 1)).toHaveAccessibleName(
      'Refs #12, opens the issue',
    );
    await expect(closes(page, 1)).toHaveText('Closes #10');
    await expect(refs(page, 2)).toHaveCount(0);
    const border = (locator: ReturnType<typeof refs>) =>
      locator.evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(await border(refs(page, 1))).not.toBe(await border(closes(page, 1)));
  });

  test('names the repository for a cross-repo reference', async ({ page }) => {
    await mockBoard(page, {
      pullRequests: [
        pullRequest(1, [], [link(4, 'refs', 'alrayyes/other', false)]),
      ],
    });
    await page.goto('/pull-requests.html');

    await expect(refs(page, 1)).toHaveText('Refs alrayyes/other#4');
  });

  test('opens the issue dialog in place from the keyboard and returns focus on Escape', async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [pullRequest(1, [], [link(12, 'refs')])],
      issues: [issue(12)],
    });
    await page.goto('/pull-requests.html');

    await refs(page, 1).focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: /^Issue details/ });
    await expect(dialog).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/pull-requests.html');

    await page.keyboard.press('Escape');

    await expect(dialog).toBeHidden();
    await expect(refs(page, 1)).toBeFocused();
  });

  test('is also in the pull request pop-up', async ({ page }) => {
    await mockBoard(page, {
      pullRequests: [pullRequest(1, [], [link(12, 'refs')])],
    });
    await page.goto('/pull-requests.html');

    await page
      .getByRole('button', { name: /Pull request 1/ })
      .first()
      .click();

    const popup = page.getByRole('dialog', { name: /^Pull request details/ });
    await expect(popup.locator('.refs-issue')).toHaveText('Refs #12');
  });

  test('has a 44 px hit area on a phone, no sideways scroll and no axe violations with both pills', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockBoard(page, {
      pullRequests: [
        pullRequest(
          1,
          [link(10, 'closes')],
          [link(12, 'refs'), link(13, 'refs')],
        ),
      ],
    });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/pull-requests.html');
      await expect(refs(page, 1).first()).toBeVisible();

      const area = await refs(page, 1)
        .first()
        .evaluate((el) => {
          const after = getComputedStyle(el, '::after');
          return {
            width: Number.parseFloat(after.width),
            height: Number.parseFloat(after.height),
          };
        });
      expect(area.height, scheme).toBeGreaterThanOrEqual(44);
      expect(area.width, scheme).toBeGreaterThanOrEqual(44);
      const scrolls = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(scrolls, `${scheme} scrolls sideways`).toBe(false);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations, scheme).toEqual([]);
    }
  });
});
