import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// An open pull request dialog is patched, never rebuilt, while the board
// updates behind it (#4327): a change to the open item, a change to some other
// item and a late answer for an item the dialog has left all leave the nodes
// the reader is looking at alone. The probe stamps every element in the
// dialog and counts the stamped ones that leave the document. Mocks
// /api/v1/dashboard and the details endpoints only and writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';

const pullRequest = (number: number, over: Record<string, unknown> = {}) => ({
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
  closesIssues: [
    {
      repo: REPO,
      number: 138,
      url: `https://example.com/${REPO}/issues/138`,
      pageUrl: `/issues.html?issue=github/${REPO}/138`,
      tracked: true,
    },
  ],
  ...over,
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
  state: 'open',
});

type Board = { pullRequests: unknown[] };

// The board is read fresh by every poll, so a test changes it by assigning.
async function serve(
  page: Page,
  board: Board,
  detailsFor: (kind: string, number: number) => Promise<unknown> | unknown,
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        readIntervalSeconds: 1,
        forges: [forgeHealth('github')],
        pullRequests: board.pullRequests,
        issues: [],
      }),
    }),
  );
  for (const [endpoint, kind] of [
    ['pull-requests', 'pr'],
    ['issues', 'issue'],
  ])
    await page.route(`**/api/v1/${endpoint}/details*`, async (route: Route) => {
      const number = Number(
        new URL(route.request().url()).searchParams.get('number'),
      );
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(await detailsFor(kind, number)),
      });
    });
}

// Stamps every element inside the open dialog and starts counting the stamped
// ones that are removed. Returns what was removed, by class, on demand.
async function watch(page: Page) {
  await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) throw new Error('no open dialog');
    const w = window as unknown as { __removed: string[] };
    w.__removed = [];
    let n = 0;
    for (const el of dialog.querySelectorAll('*'))
      el.setAttribute('data-probe', String(n++));
    dialog.setAttribute('data-probe', 'dialog');
    new MutationObserver((records) => {
      for (const r of records)
        for (const node of r.removedNodes) {
          if (!(node instanceof Element)) continue;
          for (const el of [node, ...node.querySelectorAll('*')])
            if (el.hasAttribute('data-probe') && !el.isConnected)
              w.__removed.push(
                `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '').split(' ')[0]}`,
              );
        }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

const removed = (page: Page) =>
  page.evaluate(() => (window as unknown as { __removed: string[] }).__removed);

// Two polls of the one-second schedule, so a change has landed for certain.
const settle = (page: Page) => page.waitForTimeout(3500);

const footerNames = (page: Page) =>
  page
    .getByRole('dialog', { name: /^Pull request details/ })
    .locator('.details-footer')
    .evaluate((el) =>
      [...el.querySelectorAll('button, input')].map(
        (b) =>
          b.getAttribute('aria-label') ??
          b.textContent?.trim() ??
          b.getAttribute('id') ??
          '',
      ),
    );

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('dialog[open]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });

async function open(page: Page, board: Board) {
  await page.goto('/pull-requests.html');
  await page
    .getByRole('button', { name: /Pull request 1\b/ })
    .first()
    .click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText('The description.')).toBeVisible();
  await watch(page);
  return board;
}

test('a change to another item leaves the open dialog alone', async ({
  page,
}) => {
  const board: Board = {
    pullRequests: [pullRequest(1), pullRequest(2)],
  };
  await serve(page, board, () => details('The description.'));
  await open(page, board);
  const names = await footerNames(page);

  board.pullRequests = [
    pullRequest(1),
    pullRequest(2, { ci: 'failure', updatedAt: ago(1) }),
  ];
  await settle(page);

  expect(await removed(page)).toEqual([]);
  expect(await footerNames(page)).toEqual(names);
  await expectNoViolations(page);
});

test('a poll that changes nothing leaves the open dialog alone', async ({
  page,
}) => {
  const board: Board = { pullRequests: [pullRequest(1)] };
  await serve(page, board, () => details('The description.'));
  await open(page, board);

  await settle(page);

  expect(await removed(page)).toEqual([]);
});

test('a state change of the open item keeps the header, band, body, scroll and focus', async ({
  page,
}) => {
  const board: Board = { pullRequests: [pullRequest(1)] };
  const long = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join(
    '\n\n',
  );
  await serve(page, board, () => details(long));
  await page.goto('/pull-requests.html');
  await page
    .getByRole('button', { name: /Pull request 1\b/ })
    .first()
    .click();
  await expect(dialog(page).getByText('Paragraph 79.')).toBeAttached();
  await watch(page);
  const pill = dialog(page).locator('.related-band .linked-pr').first();
  await pill.focus();
  const names = await footerNames(page);
  const scrolled = await dialog(page)
    .locator('.details-body')
    .evaluate((el) => {
      el.scrollTop = 300;
      return el.scrollTop;
    });
  expect(scrolled).toBeGreaterThan(0);

  board.pullRequests = [pullRequest(1, { ci: 'failure', updatedAt: ago(1) })];
  await settle(page);

  // The footer follows the new state; what the reader is looking at is the
  // same nodes, so scroll and focus stay.
  for (const selector of [
    '.details-header',
    '.related-band',
    '.related-band .linked-pr',
    '.details-body',
  ])
    await expect(dialog(page).locator(selector).first()).toHaveAttribute(
      'data-probe',
      /.+/,
    );
  // The footer is the one part that follows the new state.
  await expect.poll(() => footerNames(page)).not.toEqual(names);
  await expect(pill).toBeFocused();
  await expectNoViolations(page);
  expect(
    await dialog(page)
      .locator('.details-body')
      .evaluate((el) => el.scrollTop),
  ).toBe(scrolled);
});

test('a late answer for an item the dialog has left is ignored', async ({
  page,
}) => {
  const board: Board = { pullRequests: [pullRequest(1)] };
  let release: (value: unknown) => void = () => {};
  const late = new Promise((resolve) => {
    release = resolve;
  });
  await serve(page, board, (kind, number) =>
    kind === 'pr' && number === 1
      ? late
      : details(`Description of ${kind} ${number}.`),
  );
  await page.goto('/pull-requests.html');
  await page
    .getByRole('button', { name: /Pull request 1\b/ })
    .first()
    .click();
  await dialog(page).getByRole('link', { name: /#138/ }).click();
  const issue = page.getByRole('dialog', { name: /^Issue details/ });
  await expect(issue.getByText('Description of issue 138.')).toBeVisible();

  release(details('Stale pull request text.'));
  await page.waitForTimeout(500);

  await expect(issue.getByText('Description of issue 138.')).toBeVisible();
  await expect(page.getByText('Stale pull request text.')).toHaveCount(0);
});
