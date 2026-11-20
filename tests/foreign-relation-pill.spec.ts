import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #4461: a relation pill in a dialog that points at an item in a repository
// the dashboard doesn't track is a link to the forge in a new tab, marked
// external. Clicking it leaves the dialog open. Mocks /api/v1/dashboard and
// the details endpoints only and writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';
const OTHER = 'alrayyes/other';
const FORGE_URL = `https://example.com/${OTHER}`;

const ticket = (number: number, over: Record<string, unknown> = {}) => ({
  repo: REPO,
  number,
  url: `https://example.com/${REPO}/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${REPO}/${number}`,
  tracked: true,
  ...over,
});
const foreignTicket = (number: number, over: Record<string, unknown> = {}) =>
  ticket(number, {
    repo: OTHER,
    url: `${FORGE_URL}/issues/${number}`,
    pageUrl: `/issues.html?issue=github/${OTHER}/${number}`,
    tracked: false,
    ...over,
  });

const pullRequest = (over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number: 1,
  title: 'Pull request 1',
  url: 'https://example.com/pull/1',
  author: 'ryankes',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: ago(60),
  updatedAt: ago(5),
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
  closesIssues: [],
  ...over,
});

const issue = (over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number: 1,
  title: 'Issue 1',
  url: 'https://example.com/issues/1',
  author: 'ryankes',
  labels: [{ name: 'enhancement' }],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests: [],
  ...over,
});

const reference = (number: number, over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: OTHER,
  number,
  title: `Item ${number}`,
  url: `${FORGE_URL}/pull/${number}`,
  pageUrl: `/pull-requests.html?pr=github/${OTHER}/${number}`,
  kind: 'pullRequest',
  state: 'merged',
  direction: 'outgoing',
  relation: 'mentions',
  ...over,
});

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'The description.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
  state: 'open',
};

async function mockBoard(
  page: Page,
  board: {
    pullRequests?: unknown[];
    issues?: unknown[];
    references?: unknown[];
    issueState?: 'open' | 'closed';
  },
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: board.pullRequests ?? [],
        issues: board.issues ?? [],
      }),
    }),
  );
  for (const endpoint of ['pull-requests', 'issues'])
    await page.route(`**/api/v1/${endpoint}/details*`, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          endpoint === 'issues'
            ? {
                ...details,
                state: board.issueState ?? 'open',
                references: board.references ?? [],
              }
            : details,
        ),
      }),
    );
  // A click on a forge link opens a tab; nothing leaves the machine.
  await page
    .context()
    .route('https://example.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'forge' }),
    );
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const row = (dialog: Locator, label: string) =>
  dialog.getByRole('group', { name: label });

// Clicks the pill and says whether the forge opened in a new tab.
async function clickOpensTab(page: Page, pill: Locator) {
  const popup = page.waitForEvent('popup');
  await pill.click();
  const tab = await popup;
  await tab.waitForLoadState();
  return tab.url();
}

async function expectAxeClean(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, scheme).toEqual([]);
  }
}

async function openPullRequest(page: Page, pr: unknown) {
  await mockBoard(page, { pullRequests: [pr] });
  await page.goto('/pull-requests.html');
  await page
    .getByRole('button', { name: /Pull request 1/ })
    .first()
    .click();
  await expect(prDialog(page)).toBeVisible();
}

test.describe('in a pull request dialog', () => {
  for (const [label, key, name] of [
    [
      'Closes',
      'closesIssues',
      'Closes: alrayyes/other#7, opens on the forge in a new tab',
    ],
    [
      'Refs',
      'refsIssues',
      'Refs: alrayyes/other#7, does not close, opens on the forge in a new tab',
    ],
  ] as const) {
    test(`a ${label} pill to an untracked repository links to the forge and leaves the dialog open`, async ({
      page,
    }) => {
      const relation = label === 'Refs' ? 'refs' : 'closes';
      await openPullRequest(
        page,
        pullRequest({ [key]: [foreignTicket(7, { relation })] }),
      );
      const pill = row(prDialog(page), label).locator('.linked-pr');

      await expect(pill).toHaveAttribute('href', `${FORGE_URL}/issues/7`);
      await expect(pill).toHaveAttribute('target', '_blank');
      await expect(pill).toHaveAttribute('rel', /noopener/);
      await expect(pill).toHaveAccessibleName(name);
      expect(await clickOpensTab(page, pill)).toBe(`${FORGE_URL}/issues/7`);

      await expect(prDialog(page)).toBeVisible();
      await expect(issueDialog(page)).toHaveCount(0);
    });
  }

  test('a pill to a tracked repository still swaps the dialog for the issue', async ({
    page,
  }) => {
    await openPullRequest(
      page,
      pullRequest({
        closesIssues: [ticket(138), foreignTicket(7)],
      }),
    );
    const pill = row(prDialog(page), 'Closes').locator('.linked-pr').first();
    await expect(pill).toHaveAccessibleName('Closes: #138, opens the issue');
    await expect(pill).not.toHaveAttribute('target', '_blank');

    await pill.click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(prDialog(page)).toBeHidden();
  });
});

test.describe('in an issue dialog', () => {
  test('a pill to a pull request in an untracked repository links to the forge and leaves the dialog open', async ({
    page,
  }) => {
    await mockBoard(page, {
      issues: [issue()],
      references: [
        reference(9, { relation: 'mentions' }),
        reference(10, { relation: 'closes' }),
        reference(11, { relation: 'refs' }),
      ],
    });
    await page.goto('/issues.html');
    await page
      .locator('#issue-rows .row')
      .first()
      .locator('button.title')
      .click();
    const dialog = issueDialog(page);
    await expect(dialog).toBeVisible();
    const pill = row(dialog, 'Mentions').locator('.linked-pr');

    await expect(pill).toHaveAttribute('href', `${FORGE_URL}/pull/9`);
    await expect(pill).toHaveAttribute('target', '_blank');
    await expect(pill).toHaveAttribute('rel', /noopener/);
    await expect(pill).toHaveAccessibleName(
      'Mentions: PR alrayyes/other#9 · Merged, opens on the forge in a new tab',
    );
    await expectAxeClean(page);
    expect(await clickOpensTab(page, pill)).toBe(`${FORGE_URL}/pull/9`);

    await expect(dialog).toBeVisible();
    await expect(prDialog(page)).toHaveCount(0);
    for (const [label, number] of [
      ['Closes', 10],
      ['Refs', 11],
    ] as const)
      await expect(row(dialog, label).locator('.linked-pr')).toHaveAttribute(
        'href',
        `${FORGE_URL}/pull/${number}`,
      );
  });

  test('a closed issue opened from a pull request lists the foreign pull request that closed it as a forge link', async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [pullRequest({ closesIssues: [ticket(4055)] })],
      issueState: 'closed',
      references: [
        reference(3, { direction: 'incoming', relation: 'closes' }),
        reference(4, { direction: 'incoming', relation: 'mentions' }),
      ],
    });
    await page.goto('/pull-requests.html');
    await page
      .getByRole('button', { name: /Pull request 1/ })
      .first()
      .click();
    await row(prDialog(page), 'Closes').locator('.linked-pr').click();
    const dialog = issueDialog(page);
    await expect(dialog).toBeVisible();
    const pill = row(dialog, 'Closed by').locator('.linked-pr');

    await expect(pill).toHaveAttribute('target', '_blank');
    expect(await clickOpensTab(page, pill)).toBe(`${FORGE_URL}/pull/3`);

    await expect(dialog).toBeVisible();
    await expect(prDialog(page)).toBeHidden();
    await expect(
      row(dialog, 'Mentioned by').locator('.linked-pr'),
    ).toHaveAttribute('target', '_blank');
  });

  test('a pill to a pull request in a tracked repository keeps its page address', async ({
    page,
  }) => {
    await mockBoard(page, {
      issues: [issue()],
      references: [
        reference(9, {
          repo: REPO,
          url: `https://example.com/${REPO}/pull/9`,
          pageUrl: `/pull-requests.html?pr=github/${REPO}/9`,
        }),
      ],
    });
    await page.goto('/issues.html');
    await page
      .locator('#issue-rows .row')
      .first()
      .locator('button.title')
      .click();
    const pill = row(issueDialog(page), 'Mentions').locator('.linked-pr');
    await expect(pill).not.toHaveAttribute('target', '_blank');
    await expect(pill).toHaveAttribute(
      'href',
      `/pull-requests.html?pr=github/${REPO}/9`,
    );
  });
});
