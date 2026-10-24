import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The pill on a pull request row that closes an issue, and the pill on an
// issue row that a pull request will close, open that item's dialog where the
// reader is. They do not load the other page first. Mocks /api/dashboard and
// the details endpoints only and writes no saved state.
// https://github.com/alrayyes/forge-dashboard/issues/2146

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
        expect(new URL(page.url()).pathname).toBe('/pull-requests.html');
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
      'Pull request #12, closes this issue',
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
    expect(new URL(page.url()).pathname).toBe('/issues.html');
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
        expect(new URL(page.url()).pathname).toBe('/issues.html');
        await axeClean(page, `${scheme} at ${width}px`);
      }
    }
  });
});

const mention = (number: number, tracked = true) => ({
  ...closing(number),
  tracked,
});
const openPullDialog = (page: Page, number: number) =>
  page.getByRole('button', { name: `#${number} Pull request ${number}` });

test.describe('pills inside the pull request dialog', () => {
  test('a closing pill swaps the dialog for the issue dialog on the same page', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(1, [closing(12)])],
      issues: [issue(12)],
    });
    await page.goto('/pull-requests.html');
    await openPullDialog(page, 1).click();
    await expect(pullDialog(page)).toBeVisible();

    const pill = pullDialog(page).locator('.closing-issue');
    await expect(pill).toHaveAttribute('href', closing(12).pageUrl);
    await pill.click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(pullDialog(page)).toHaveCount(0);
    await expect(issueDialog(page)).toHaveAccessibleName(
      `Issue details: ${REPO} #12`,
    );
    expect(new URL(page.url()).pathname).toBe('/pull-requests.html');
    expect(new URL(page.url()).search).toBe('');
    // Focus moved into the new dialog.
    expect(
      await issueDialog(page).evaluate((d) =>
        d.contains(document.activeElement),
      ),
    ).toBe(true);

    await page.keyboard.press('Escape');
    await expect(issueDialog(page)).toBeHidden();
  });

  test('a mentions pill for a ticket the dashboard holds opens its dialog', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(1, [], { mentionsIssues: [mention(12)] })],
      issues: [issue(12)],
    });
    await page.goto('/pull-requests.html');
    await openPullDialog(page, 1).click();

    await pullDialog(page).locator('.mention-pill').click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(pullDialog(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/pull-requests.html');
  });

  test('a mentions pill for a ticket the dashboard does not hold still links to the forge', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(1, [], { mentionsIssues: [mention(99, false)] })],
    });
    await page.goto('/pull-requests.html');
    await openPullDialog(page, 1).click();

    const pill = pullDialog(page).locator('.mention-pill');
    await expect(pill).toHaveAttribute('href', closing(99).url);
    await expect(pill).toHaveAttribute('target', '_blank');
    await pill.click();
    await expect(pullDialog(page)).toBeVisible();
  });

  test('a modified click is left to the browser and the dialog stays', async ({
    page,
    context,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(1, [closing(12)])],
      issues: [issue(12)],
    });
    await page.goto('/pull-requests.html');
    await openPullDialog(page, 1).click();

    const opened = context.waitForEvent('page');
    await pullDialog(page)
      .locator('.closing-issue')
      .click({ modifiers: ['Control'] });
    expect((await opened).url()).toContain('/issues.html?issue=github/');
    await expect(pullDialog(page)).toBeVisible();
  });

  test('works from the keyboard and at phone width, axe clean', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockBoard(page, {
      shown: [pullRequest(1, [closing(12)])],
      issues: [issue(12)],
    });
    await page.goto('/pull-requests.html');
    await openPullDialog(page, 1).click();
    await pullDialog(page).locator('.closing-issue').focus();
    await page.keyboard.press('Enter');

    await expect(issueDialog(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/pull-requests.html');
    expect(new URL(page.url()).search).toBe('');
    await axeClean(page, 'issue dialog opened from the pull request dialog');
  });

  test('works on the Issues page too: an issue dialog swaps to the pull request dialog and back', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(12, [closing(1)])],
      issues: [issue(1, [linked(12)])],
    });
    await page.goto('/issues.html');
    await page.locator('#issue-rows .row button.title').first().click();
    await issueDialog(page).locator('.linked-pr').click();
    await expect(pullDialog(page)).toBeVisible();

    await pullDialog(page).locator('.closing-issue').click();
    await expect(issueDialog(page)).toBeVisible();
    await expect(pullDialog(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/issues.html');
    expect(new URL(page.url()).search).toBe('');
  });
});

test.describe('references inside the issue dialog', () => {
  test('on the Pull requests page a pull request reference opens the pull request dialog', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(1, [closing(12)]), pullRequest(13)],
      issues: [issue(12, [linked(13)])],
    });
    await page.goto('/pull-requests.html');
    await closingPill(page, 1).click();
    await expect(issueDialog(page)).toBeVisible();

    await issueDialog(page).locator('.linked-pr').click();

    await expect(pullDialog(page)).toBeVisible();
    await expect(pullDialog(page)).toHaveAccessibleName(
      `Pull request details: ${REPO} #13`,
    );
    await expect(issueDialog(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/pull-requests.html');
    // The board's own dialog, with its actions, not the read-only one.
    await expect(pullDialog(page).getByRole('button').last()).toBeVisible();
  });

  test('a reference the dashboard does not hold is said plainly on the Pull requests page', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(1, [closing(12)])],
      issues: [issue(12, [linked(13)])],
    });
    await page.goto('/pull-requests.html');
    await closingPill(page, 1).click();
    await issueDialog(page).locator('.linked-pr').click();

    await expect(pullDialog(page)).toBeHidden();
    await expect(page.locator('#hide-status')).toContainText(`${REPO} #13`);
  });
});

test.describe('pills revealed by "N more", and opened from the keyboard', () => {
  test('a closing-issue pill opens its dialog on Enter, and Escape returns focus to it', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [
        pullRequest(1, [closing(12), closing(13), closing(14), closing(15)]),
      ],
      issues: [issue(12), issue(13), issue(14), issue(15)],
    });
    await page.goto('/pull-requests.html');

    await page
      .getByRole('button', {
        name: '2 more issues that this pull request will close',
      })
      .click();
    const revealed = closingPill(page, 1).nth(2);
    await expect(revealed).toBeFocused();
    await expect(revealed).toHaveAccessibleName('Closes #14, opens the issue');

    await page.keyboard.press('Enter');

    await expect(issueDialog(page)).toHaveAccessibleName(
      `Issue details: ${REPO} #14`,
    );
    expect(new URL(page.url()).pathname).toBe('/pull-requests.html');

    await page.keyboard.press('Escape');

    await expect(issueDialog(page)).toBeHidden();
    await expect(revealed).toBeFocused();
  });

  test('a linked pull request pill opens its dialog on Enter, and Escape returns focus to it', async ({
    page,
  }) => {
    await mockBoard(page, {
      shown: [pullRequest(12), pullRequest(13), pullRequest(14)],
      issues: [issue(1, [linked(12), linked(13), linked(14)])],
    });
    await page.goto('/issues.html');

    await page
      .getByRole('button', {
        name: '1 more pull requests that will close this issue',
      })
      .click();
    const revealed = linkedPill(page, 1).nth(2);
    await expect(revealed).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(pullDialog(page)).toHaveAccessibleName(
      `Pull request details: ${REPO} #14`,
    );
    expect(new URL(page.url()).pathname).toBe('/issues.html');

    await page.keyboard.press('Escape');

    await expect(pullDialog(page)).toBeHidden();
    await expect(revealed).toBeFocused();
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
