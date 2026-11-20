import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// An open issue pop-up stays an issue across a refresh, and a pull request
// pop-up stays a pull request, when the other kind has the same number in
// another repository (#4402). Mocks /api/v1/dashboard and the details
// endpoints only and writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
// Every poll moves every item's updatedAt, so each open pop-up reads again.
let polls = 0;
const stamp = () => new Date(NOW.getTime() + polls * 1000).toISOString();
const REPO = 'alrayyes/forge-dashboard';

const SHARED = 7;

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

const pullRequest = (
  forge: string,
  repo: string,
  number: number,
  over: Record<string, unknown> = {},
) => ({
  forge,
  repo,
  number,
  title: `Pull request ${repo}#${number}`,
  url: `https://example.com/${repo}/pull/${number}`,
  author: 'ryankes',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: ago(60),
  updatedAt: stamp(),
  mergeStatus: 'mergeable',
  behind: false,
  kind: 'regular',
  closesIssues: [],
  mentionsIssues: [],
  ...over,
});
const issue = (forge: string, repo: string, number: number, over = {}) => ({
  forge,
  repo,
  number,
  title: `Issue ${repo}#${number}`,
  url: `https://example.com/${repo}/issues/${number}`,
  author: 'ryankes',
  labels: [],
  createdAt: ago(60),
  updatedAt: stamp(),
  linkedPullRequests: [],
  mentionedByPullRequests: [],
  ...over,
});
const mention = (forge: string, repo: string, number: number) => ({
  repo,
  number,
  url: `https://example.com/${repo}/issues/${number}`,
  pageUrl: `/issues.html?issue=${forge}/${repo}/${number}`,
  tracked: true,
});
const linked = (forge: string, repo: string, number: number) => ({
  forge,
  repo,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=${forge}/${repo}/${number}`,
  ci: 'success',
  checks: { passed: 3, running: 0, waiting: 0, failed: 0 },
  awaitingWorkflowApproval: false,
});

// The pull request REPO#1 mentions REPO#7 (an issue), while REPO#7 is a
// pull request: two items with one number. The issue REPO#7 is mentioned by
// REPO#1, which gives the reverse trip a pill to follow.
async function mockBoard(page: Page) {
  polls = 0;
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) => {
    polls++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github'), forgeHealth('forgejo')],
        pullRequests: [
          pullRequest('forgejo', REPO, 1, {
            mentionsIssues: [mention('forgejo', REPO, SHARED)],
          }),
          pullRequest('github', REPO, SHARED),
        ],
        issues: [
          issue('forgejo', REPO, SHARED, {
            linkedPullRequests: [linked('forgejo', REPO, 1)],
          }),
          issue('github', REPO, 1),
        ],
      }),
    });
  });
  await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(details('A pull request body.')),
    }),
  );
  await page.route('**/api/v1/issues/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(details('An issue body.')),
    }),
  );
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });

async function pastARefresh(page: Page) {
  const before = polls;
  await page.clock.fastForward(5 * 60_000);
  await expect.poll(() => polls).toBeGreaterThan(before);
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
  );
}

async function axeBothSchemes(page: Page, label: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, `${label} ${scheme}`).toEqual([]);
  }
}

for (const width of [1280, 390]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.clock.install({ time: new Date() });
      await page.setViewportSize({ width, height: 844 });
      await mockBoard(page);
    });

    test('an issue opened from a pull request stays an issue across a refresh', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      await page
        .getByRole('button', {
          name: /Pull request alrayyes\/forge-dashboard#1/,
        })
        .first()
        .click();
      await prDialog(page).locator('.mention-pill').click();
      await expect(issueDialog(page)).toBeVisible();
      await expect(issueDialog(page)).toContainText('An issue body.');

      await pastARefresh(page);

      await expect(issueDialog(page)).toBeVisible();
      await expect(prDialog(page)).toHaveCount(0);
      await expect(issueDialog(page)).toContainText(`Issue ${REPO}#${SHARED}`);
      await axeBothSchemes(page, 'issue after refresh');
    });

    test('a pull request opened from an issue stays a pull request across a refresh', async ({
      page,
    }) => {
      await page.goto('/issues.html');
      await page
        .locator('#issue-rows .row', { hasText: `#${SHARED}` })
        .locator('button.title')
        .click();
      await issueDialog(page).locator('.linked-pr').first().click();
      await expect(prDialog(page)).toBeVisible();
      await expect(prDialog(page)).toContainText('A pull request body.');

      await pastARefresh(page);

      await expect(prDialog(page)).toBeVisible();
      await expect(issueDialog(page)).toHaveCount(0);
      await expect(prDialog(page)).toContainText(`${REPO}#1`);
      await axeBothSchemes(page, 'pull request after refresh');
    });
  });
}

// A Mentions pill to a merged pull request (so untracked) is a pull request
// from the first frame: the first read of it said so, and the dialog does
// not call it an issue while a later read is on its way.
for (const width of [1280, 390]) {
  test.describe(`a mentioned pull request that is not on the board at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.clock.install({ time: new Date() });
      await page.setViewportSize({ width, height: 844 });
      await mockBoard(page);
      await page.unroute('**/api/v1/dashboard*');
      await page.route('**/api/v1/dashboard*', (route: Route) => {
        polls++;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            forges: [forgeHealth('github')],
            pullRequests: [
              pullRequest('github', REPO, 1, {
                mentionsIssues: [
                  { ...mention('github', REPO, 4343), tracked: false },
                ],
              }),
            ],
            issues: [],
          }),
        });
      });
      let reads = 0;
      await page.unroute('**/api/v1/issues/details*');
      await page.route('**/api/v1/issues/details*', async (route: Route) => {
        reads++;
        // The first read warms the pill; every later one is slow.
        if (reads > 1) await new Promise((r) => setTimeout(r, 1500));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...details('The merged one.'),
            kind: 'pullRequest',
            state: 'closed',
            pullRequest: {
              title: 'Merged thing',
              state: 'merged',
              author: null,
            },
          }),
        });
      });
    });

    test('opens as a pull request, never as an issue, and stays one', async ({
      page,
    }) => {
      await page.goto('/pull-requests.html');
      await page
        .getByRole('button', {
          name: /Pull request alrayyes\/forge-dashboard#1/,
        })
        .first()
        .click();
      const pill = prDialog(page).locator('.mention-pill');
      const answered = page.waitForResponse('**/api/v1/issues/details*');
      await pill.hover();
      await answered;
      await pill.click();
      // Samples the dialog every 20 ms. It relies on the 1500 ms delay of the
      // second read (see the route above): the first 1000 ms are all spent
      // while that read is still out, so what the dialog shows then is what the
      // warm read gave it, with nothing newer to lean on.
      const sampled = await page.evaluate(
        () =>
          new Promise<{
            labels: string[];
            early: { skeleton: boolean; text: string }[];
          }>((resolve) => {
            const labels = new Set<string>();
            const early: { skeleton: boolean; text: string }[] = [];
            const start = Date.now();
            const look = () => {
              const d = document.querySelector('dialog[open]');
              if (!d) return;
              labels.add(d.getAttribute('aria-label') ?? '');
              if (Date.now() - start >= 300 && Date.now() - start < 1000)
                early.push({
                  skeleton: d.querySelector('.details-skeleton') !== null,
                  text: d.textContent ?? '',
                });
            };
            const timer = setInterval(look, 20);
            setTimeout(() => {
              clearInterval(timer);
              resolve({ labels: [...labels], early });
            }, 2000);
          }),
      );
      const seen = sampled.labels;
      // While the slow read is out the dialog already shows the pull request:
      // title, state and body, and no skeleton in any frame.
      expect(sampled.early.length).toBeGreaterThan(5);
      for (const frame of sampled.early) {
        expect(frame.skeleton).toBe(false);
        expect(frame.text).toContain('Merged thing');
        expect(frame.text).toMatch(/merged/i);
        expect(frame.text).toContain('The merged one.');
      }
      expect(seen.filter((l) => l.startsWith('Issue details'))).toEqual([]);
      await expect(prDialog(page)).toBeVisible();
      await pastARefresh(page);
      await expect(prDialog(page)).toBeVisible();
      await expect(issueDialog(page)).toHaveCount(0);
      await axeBothSchemes(page, 'mentioned pull request after refresh');
    });
  });
}
