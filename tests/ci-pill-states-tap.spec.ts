import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { navCountsFor } from './nav-counts-helper';
import { test } from './server-fixture';

// The pill states #4755's spec left untapped (#4756): the pill on a row that
// shows the wait chip, the pill on an armed auto-merge row, the badge in the
// Related band, and the no-checks pill that is deliberately not a button.
// https://github.com/alrayyes/forge-dashboard/issues/4756
// Refs #4753

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const REPO = 'alrayyes/forge-dashboard';

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.test/alrayyes/app/pull/${number}`,
    author: 'ryankes',
    draft: false,
    ci: 'pending',
    checks: { passed: 4, running: 2, waiting: 0, failed: 0 },
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'blocked',
    behind: false,
    kind: 'regular',
    closesIssues: [],
    ...overrides,
  };
}

const DETAILS = {
  description: {
    text: 'The description.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: {
      thumbsUp: { count: 0, logins: [] },
      thumbsDown: { count: 0, logins: [] },
    },
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
  state: 'open',
  references: [],
};

async function serve(
  page: Page,
  board: { pullRequests?: unknown[]; issues?: unknown[]; forge?: string },
) {
  const pullRequests = board.pullRequests ?? [];
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth((board.forge ?? 'github') as 'github')],
        pullRequests,
        issues: board.issues ?? [],
        openIssueCount: (board.issues ?? []).length,
        navCounts: navCountsFor(pullRequests, 0),
      }),
    }),
  );
  for (const endpoint of ['pull-requests', 'issues'])
    await page.route(`**/api/v1/${endpoint}/details*`, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DETAILS),
      }),
    );
}

const checks = (page: Page) =>
  page.getByRole('dialog', { name: 'Pipeline checks' });

async function axeClean(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const { violations } = await new AxeBuilder({ page })
      .withTags(AXE_TAGS)
      .analyze();
    expect(violations, scheme).toEqual([]);
  }
}

// Every part of the pill that a finger can land on opens the dialog.
async function everyPartOpens(page: Page, pill: Locator) {
  await expect(pill).toBeVisible();
  const parts = pill.locator('.ci-word:visible, .ci-seg:visible');
  const n = await parts.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await parts.nth(i).tap({ force: true });
    await expect(checks(page)).toBeVisible();
    await expect(page.locator('.ci-pill-tip')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(checks(page)).toBeHidden();
    await expect(pill).toBeFocused();
  }
}

const rowPill = (page: Page) => page.locator('#pr-rows .row .ci-pill').first();

const forgejoArmed = (over: Record<string, unknown> = {}) =>
  pr(7, {
    forge: 'forgejo',
    repo: 'alrayyes/dotfiles',
    autoMergeEnabled: true,
    autoMerge: {
      state: 'waiting',
      code: 'checks_pending',
      message: 'Auto-merge is waiting for checks to finish.',
    },
    allowedActions: [
      { action: 'merge' },
      { action: 'close' },
      { action: 'cancel_auto_merge' },
    ],
    ...over,
  });

test.describe('on a phone (#4756)', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('the pill on a row that shows the wait chip opens the dialog', async ({
    page,
  }) => {
    await serve(page, { pullRequests: [forgejoArmed()], forge: 'forgejo' });
    await page.goto('/pull-requests.html');
    await expect(page.locator('#pr-rows .row .wait-chip')).toBeVisible();
    await everyPartOpens(page, rowPill(page));
    await axeClean(page);
  });

  test('the pill on an armed auto-merge row opens the dialog', async ({
    page,
  }) => {
    // Armed and stopped: no chip, the pill sits beside the auto-merge line.
    await serve(page, {
      pullRequests: [
        pr(8, {
          ci: 'failure',
          checks: { passed: 5, running: 0, waiting: 0, failed: 2 },
          autoMergeEnabled: true,
          autoMerge: {
            state: 'stopped',
            code: 'checks_failed',
            message: 'Auto-merge stopped: a check failed.',
          },
        }),
      ],
    });
    await page.goto('/pull-requests.html');
    await everyPartOpens(page, rowPill(page));
    await axeClean(page);
  });

  test('the badge in the Related band shows its tip on a tap and opens nothing', async ({
    page,
  }) => {
    const linked = {
      forge: 'github',
      repo: REPO,
      number: 142,
      draft: false,
      pageUrl: `/pull-requests.html?pr=github/${REPO}/142`,
      ci: 'pending',
      checks: { passed: 3, running: 2, waiting: 0, failed: 1 },
      awaitingWorkflowApproval: false,
    };
    await serve(page, {
      issues: [
        {
          forge: 'github',
          repo: REPO,
          number: 1,
          title: 'Issue 1',
          url: 'https://example.test/issues/1',
          author: 'ryankes',
          labels: [{ name: 'enhancement' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          linkedPullRequests: [linked],
        },
      ],
    });
    await page.goto('/issues.html');
    await page
      .locator('#issue-rows .row')
      .first()
      .locator('button.title')
      .click();
    const dialog = page.getByRole('dialog', { name: /^Issue details/ });
    await expect(dialog).toBeVisible();
    const badge = dialog
      .getByRole('group', { name: 'Closed by' })
      .locator('.ci-pill')
      .first();
    await expect(badge).toBeVisible();
    await expect(badge).not.toHaveJSProperty('tagName', 'BUTTON');

    await badge.locator('.ci-seg-running').tap({ force: true });
    await expect(page.locator('.ci-pill-tip')).toBeVisible();
    await expect(page.locator('.ci-pill-tip')).toHaveText(/running/i);
    // The tap neither opened the checks nor followed the link.
    await expect(checks(page)).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/issues\.html/);
    await axeClean(page);
  });

  test('the no-checks pill is plain text, not a button, and a tap does nothing', async ({
    page,
  }) => {
    await serve(page, {
      pullRequests: [pr(9, { ci: 'none', checks: undefined })],
    });
    await page.goto('/pull-requests.html');
    const row = page.locator('#pr-rows .row').first();
    const pill = rowPill(page);
    await expect(pill).toHaveText('No checks');
    await expect(pill).toHaveJSProperty('tagName', 'SPAN');
    await expect(pill).not.toHaveAttribute('aria-label', /.*/);
    await expect(row.getByRole('button', { name: /checks/i })).toHaveCount(0);
    await expect(pill).toHaveCSS('cursor', 'auto');
    const before = await pill.evaluate((e) => getComputedStyle(e).filter);
    await pill.hover();
    expect(await pill.evaluate((e) => getComputedStyle(e).filter)).toBe(before);
    expect(before).toBe('none');
    await pill.tap({ force: true });
    await expect(checks(page)).toBeHidden();
    await expect(page.locator('.ci-pill-tip')).toBeHidden();
    await axeClean(page);
  });
});
