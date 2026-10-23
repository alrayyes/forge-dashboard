import { expect, type Page, type Route } from '@playwright/test';
import {
  clearLabels,
  pickedLabels,
  pickedValues,
  pickOnly,
  toggleLabels,
  togglePicks,
} from './label-filter-helper';
import { test } from './server-fixture';

// #1713: the saved filters come from the cookie, read at once, and from the
// server copy, fetched a moment later. A filter changed while that copy is
// still loading is newer than it, so the copy must not overwrite it, and the
// change must be saved. The other fields still take the copy. Each test holds
// the copy's request, edits, releases it and reads the page and the server.
// The saved state is on the server, so this spec registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/1713

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

const ISSUES = [
  issue(1),
  issue(2, { author: 'sam', labels: [{ name: 'docs', color: '0366d6' }] }),
  issue(3, { author: 'dana', labels: [] }),
];

const ENDPOINT = '/api/settings/filter-state';

async function stub(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

// Holds the saved copy's response until release() is called. requested
// resolves once the page has asked for it, so an edit is made while it is
// really in flight.
async function holdCopy(page: Page) {
  let release: () => void = () => {};
  let asked: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    asked = resolve;
  });
  await page.route(`**${ENDPOINT}`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    asked();
    // The server answers at once; it is only the page that gets the answer
    // late, as on a slow link. Fetching it first keeps the copy from
    // reflecting the edit's own save.
    const response = await route.fetch();
    await gate;
    return route.fulfill({ response });
  });
  return { release, requested };
}

const savedCopy = async (page: Page) =>
  (await (await page.request.get(ENDPOINT)).json()) as {
    shared?: Record<string, string>;
    issue?: Record<string, string>;
  };

const issueRows = (page: Page) => page.locator('#issue-rows > .row');
const dashboardBox = (page: Page) =>
  page.locator('#issue-hide-dependency-dashboard');

// The fields the copy carries; a test passes the one it edited, which keeps
// its own value instead.
async function expectCopyApplied(
  page: Page,
  edited: 'box' | 'author' | 'title' | 'regex',
) {
  await expect.poll(() => pickedLabels(page)).toEqual(['bug']);
  if (edited !== 'author')
    await expect
      .poll(() => pickedValues(page, 'author'))
      .toEqual(['github:ryan']);
  if (edited !== 'title')
    await expect(page.locator('input[data-col="title"]')).toHaveValue('issue');
  if (edited !== 'regex')
    await expect(page.locator('#issue-hide-title-regex')).toHaveValue('qqq');
  if (edited !== 'box') await expect(dashboardBox(page)).toBeChecked();
}

test.describe('an edit made while the saved copy loads wins over it (#1713)', () => {
  test.beforeEach(async ({ page }) => {
    await stub(page);
    // What another browser saved: the box ticked, a label, an author and
    // title text picked, and a hide-titles pattern.
    const put = await page.request.put(ENDPOINT, {
      data: {
        shared: { label: 'bug', author: 'github:ryan', title: 'issue' },
        pr: {},
        issue: { hideDependencyDashboard: '1', hideTitleRegex: 'qqq' },
        view: {},
      },
    });
    expect(put.ok()).toBe(true);
    // This browser has no cookie, so the copy is all it has to go on.
    await page.context().clearCookies({ name: 'forge-board-filters' });
  });

  test('a copy that arrives before any edit applies as before', async ({
    page,
  }) => {
    await page.goto('/issues.html');
    await expectCopyApplied(page, 'regex');
    await expect(page.locator('#issue-hide-title-regex')).toHaveValue('qqq');
    await expect(issueRows(page)).toHaveCount(1);
  });

  test('an unticked box stays unticked and is saved, the label still takes the copy', async ({
    page,
  }) => {
    const copy = await holdCopy(page);
    await page.goto('/issues.html');
    await expect(issueRows(page)).toHaveCount(3);
    await copy.requested;
    await dashboardBox(page).uncheck();
    copy.release();

    await expectCopyApplied(page, 'box');
    await expect(issueRows(page)).toHaveCount(1);
    await expect(dashboardBox(page)).not.toBeChecked();
    await expect
      .poll(async () => {
        const saved = await savedCopy(page);
        return [
          saved.issue?.hideDependencyDashboard,
          saved.shared?.label,
          saved.shared?.author,
          saved.shared?.title,
          saved.issue?.hideTitleRegex,
        ];
      })
      .toEqual(['', 'bug', 'github:ryan', 'issue', 'qqq']);
  });

  test('a cleared author stays cleared and is saved, the label still takes the copy', async ({
    page,
  }) => {
    const copy = await holdCopy(page);
    await page.goto('/issues.html');
    await expect(issueRows(page)).toHaveCount(3);
    await copy.requested;
    // Ticked and unticked: the person's own change, so the copy leaves it.
    await togglePicks(page, 'author', 'github:ryan');
    await togglePicks(page, 'author', 'github:ryan');
    copy.release();

    await expectCopyApplied(page, 'author');
    await expect.poll(() => pickedValues(page, 'author')).toEqual([]);
    await expect
      .poll(async () => {
        const saved = await savedCopy(page);
        return [saved.shared?.author ?? '', saved.shared?.label];
      })
      .toEqual(['', 'bug']);
  });

  test('typed title text stays and is saved, the label still takes the copy', async ({
    page,
  }) => {
    const copy = await holdCopy(page);
    await page.goto('/issues.html');
    await expect(issueRows(page)).toHaveCount(3);
    await copy.requested;
    await page.locator('input[data-col="title"]').fill('issue 1');
    copy.release();

    await expectCopyApplied(page, 'title');
    await expect(page.locator('input[data-col="title"]')).toHaveValue(
      'issue 1',
    );
    await expect
      .poll(async () => {
        const saved = await savedCopy(page);
        return [saved.shared?.title, saved.shared?.label];
      })
      .toEqual(['issue 1', 'bug']);
  });

  test('the hide-titles pattern stays and is saved', async ({ page }) => {
    const copy = await holdCopy(page);
    await page.goto('/issues.html');
    await expect(issueRows(page)).toHaveCount(3);
    await copy.requested;
    await page.locator('#issue-hide-title-regex').fill('zzz');
    copy.release();

    await expectCopyApplied(page, 'regex');
    await expect(page.locator('#issue-hide-title-regex')).toHaveValue('zzz');
    await expect
      .poll(async () => (await savedCopy(page)).issue?.hideTitleRegex)
      .toBe('zzz');
  });

  test('Clear filters during the load is not undone by the copy', async ({
    page,
  }) => {
    // The cookie knows one pick, so the button is on offer while the copy,
    // which also has an author, is still out.
    await page.goto('/issues.html');
    await expect.poll(() => pickedLabels(page)).toEqual(['bug']);
    await clearLabels(page);
    await toggleLabels(page, 'bug');
    await expect
      .poll(async () => (await savedCopy(page)).shared?.label)
      .toBe('bug');
    const put = await page.request.put(ENDPOINT, {
      data: {
        shared: { label: 'bug', author: 'github:ryan' },
        pr: {},
        issue: { hideDependencyDashboard: '1' },
        view: {},
      },
    });
    expect(put.ok()).toBe(true);

    const copy = await holdCopy(page);
    await page.reload();
    await expect(issueRows(page)).toHaveCount(1);
    await copy.requested;
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(issueRows(page)).toHaveCount(3);
    copy.release();

    await expect.poll(() => pickedLabels(page)).toEqual([]);
    await expect.poll(() => pickedValues(page, 'author')).toEqual([]);
    await expect(issueRows(page)).toHaveCount(3);
    await expect
      .poll(async () => {
        const saved = await savedCopy(page);
        return [saved.shared?.label ?? '', saved.shared?.author ?? ''];
      })
      .toEqual(['', '']);
  });
});

test.describe('an edit made while the saved copy loads wins on Webhooks', () => {
  const REPOS = [
    { forge: 'github', fullName: 'acme/app', hasWebhook: true },
    { forge: 'forgejo', fullName: 'acme/infra', hasWebhook: false },
  ].map((r) => ({
    ...r,
    ignored: false,
    ignoredPRs: false,
    ignoredIssues: false,
    autoUpdateBranch: false,
    canManageWebhooks: true,
  }));

  test('a changed status stays and is saved, the repo search still takes the copy', async ({
    page,
  }) => {
    await page.route('**/api/dashboard/stream*', (route: Route) =>
      route.abort(),
    );
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [],
          pullRequests: [],
          issues: [],
          repos: REPOS,
        }),
      }),
    );
    // What another browser saved: a repo search and the Confirmed status.
    const put = await page.request.put(ENDPOINT, {
      data: {
        shared: {},
        pr: {},
        issue: {},
        view: {},
        webhooks: { repo: 'acme', status: 'confirmed' },
      },
    });
    expect(put.ok()).toBe(true);
    // This browser has no cookie, so the copy is all it has to go on.
    await page.context().clearCookies({ name: 'forge-board-filters' });

    const copy = await holdCopy(page);
    await page.goto('/webhooks.html');
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(2);
    await copy.requested;
    await page.locator('#webhooks-status-filter').selectOption('pending');
    copy.release();

    await expect(page.locator('#webhooks-repo-filter')).toHaveValue('acme');
    await expect(page.locator('#webhooks-status-filter')).toHaveValue(
      'pending',
    );
    await expect(page.locator('#webhooks-rows tr')).toHaveCount(1);
    await expect
      .poll(async () => {
        const saved = (await (await page.request.get(ENDPOINT)).json()) as {
          webhooks?: Record<string, string>;
        };
        return [saved.webhooks?.repo, saved.webhooks?.status];
      })
      .toEqual(['acme', 'pending']);
  });
});
