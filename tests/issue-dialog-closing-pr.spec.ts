import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The issue dialog lists the pull requests that will close the issue, drawn
// by the same code as the pill on the issue row. Mocks /api/dashboard and the
// issue details endpoint only and writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';

const none = { passed: 0, running: 0, waiting: 0, failed: 0 };
const linked = (number: number, overrides: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'success',
  checks: { ...none, passed: 3 },
  awaitingWorkflowApproval: false,
  ...overrides,
});

const issue = (number: number, linkedPullRequests: unknown[]) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [{ name: 'enhancement' }],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests,
});

async function mockBoard(page: Page, issues: () => unknown[]) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  const snapshot = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: issues(),
      }),
    });
  await page.route('**/api/dashboard/refresh', snapshot);
  await page.route('**/api/dashboard*', snapshot);
  await page.route('**/api/issues/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: 'The issue text.',
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
      }),
    }),
  );
}

const rowPills = (page: Page) =>
  page.locator('#issue-rows .row').first().locator('.linked-pr');
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const dialogPills = (page: Page) => dialog(page).locator('.linked-pr');
const openDialog = (page: Page) =>
  page.locator('#issue-rows .row').first().locator('button.title').click();

test('the dialog shows the closing pull request with the row pill, same name and text', async ({
  page,
}) => {
  await mockBoard(page, () => [issue(1, [linked(12)])]);
  await page.goto('/issues.html');
  await openDialog(page);

  await expect(dialog(page)).toBeVisible();
  await expect(dialogPills(page)).toHaveCount(1);
  const name = await rowPills(page).getAttribute('aria-label');
  await expect(dialogPills(page)).toHaveAttribute('aria-label', name ?? '');
  await expect(dialogPills(page)).toHaveText(
    (await rowPills(page).textContent()) ?? '',
  );
  await expect(dialogPills(page)).toHaveAttribute('href', linked(12).pageUrl);
});

test('the dialog pill shows the same CI state as the row, failing and passing', async ({
  page,
}) => {
  const failing = linked(12, {
    ci: 'failure',
    checks: { ...none, passed: 2, failed: 1 },
  });
  const passing = linked(13);
  await mockBoard(page, () => [issue(1, [failing, passing])]);
  await page.goto('/issues.html');
  await openDialog(page);
  await expect(dialogPills(page)).toHaveCount(2);

  const signature = (pill: Locator) =>
    pill.evaluate((el) => ({
      text: el.textContent,
      ci: [...el.querySelectorAll('*')].map((n) => ({
        cls: n.className,
        color: getComputedStyle(n).color,
        bg: getComputedStyle(n).backgroundColor,
      })),
    }));
  for (const i of [0, 1]) {
    expect(await signature(dialogPills(page).nth(i))).toEqual(
      await signature(rowPills(page).nth(i)),
    );
  }
  // The two pipelines differ, so the comparison above is not vacuous.
  expect(await signature(dialogPills(page).nth(0))).not.toEqual(
    await signature(dialogPills(page).nth(1)),
  );
});

test('an issue nothing closes shows no pills in the dialog', async ({
  page,
}) => {
  await mockBoard(page, () => [issue(1, [])]);
  await page.goto('/issues.html');
  await openDialog(page);

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.linked-prs')).toHaveCount(0);
});

test('the pills follow the pull request list while the dialog stays open', async ({
  page,
}) => {
  let list: unknown[] = [];
  await mockBoard(page, () => [issue(1, list)]);
  const refresh = () =>
    page.evaluate(() =>
      document.querySelector<HTMLElement>('#force-refresh-button')?.click(),
    );
  await page.goto('/issues.html');
  await openDialog(page);
  await expect(dialog(page)).toBeVisible();
  await expect(dialogPills(page)).toHaveCount(0);
  const name = await dialog(page).getAttribute('aria-label');
  const group = (label: string) =>
    dialog(page).getByRole('group', { name: label });
  await expect(group('Labels when opened')).toBeVisible();

  list = [linked(12)];
  await refresh();
  await expect(dialogPills(page)).toHaveCount(1);
  await expect(dialog(page)).toBeVisible();
  await expect(group('Attributes when opened')).toBeVisible();
  await expect(group('Labels when opened')).toHaveCount(0);
  await expect(dialog(page)).toHaveAttribute('aria-label', name ?? '');

  list = [linked(12, { draft: true }), linked(13)];
  await refresh();
  await expect(dialogPills(page)).toHaveCount(2);
  await expect(dialogPills(page).first()).toContainText('draft');

  list = [];
  await refresh();
  await expect(dialogPills(page)).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
  await expect(group('Labels when opened')).toBeVisible();
  await expect(group('Attributes when opened')).toHaveCount(0);
  await expect(dialog(page)).toHaveAttribute('aria-label', name ?? '');
});

test('focus on a pill survives a poll that changes the list', async ({
  page,
}) => {
  let list: unknown[] = [linked(12), linked(13)];
  await mockBoard(page, () => [issue(1, list)]);
  const refresh = () =>
    page.evaluate(() =>
      document.querySelector<HTMLElement>('#force-refresh-button')?.click(),
    );
  const focusedHref = () =>
    page.evaluate(() => document.activeElement?.getAttribute('href') ?? null);
  await page.goto('/issues.html');
  await openDialog(page);
  await dialogPills(page).nth(1).focus();
  await expect.poll(focusedHref).toBe(linked(13).pageUrl);

  // The other pill is replaced: focus stays on the same one.
  list = [linked(11), linked(13)];
  await refresh();
  await expect(dialogPills(page).first()).toHaveAttribute(
    'href',
    linked(11).pageUrl,
  );
  await expect.poll(focusedHref).toBe(linked(13).pageUrl);

  // The focused one goes: focus stays inside the dialog, not on the page.
  list = [linked(11)];
  await refresh();
  await expect(dialogPills(page)).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .not.toBe('BODY');
  expect(
    await dialog(page).evaluate((d) => d.contains(document.activeElement)),
  ).toBe(true);
});

test('focus outside the pills stays put when a poll changes the list', async ({
  page,
}) => {
  let list: unknown[] = [linked(12)];
  await mockBoard(page, () => [issue(1, list)]);
  const refresh = () =>
    page.evaluate(() =>
      document.querySelector<HTMLElement>('#force-refresh-button')?.click(),
    );
  const focusedIsDialog = () =>
    dialog(page).evaluate((d) => document.activeElement === d);
  await page.goto('/issues.html');
  await openDialog(page);
  // Park focus on the dialog itself: not a pill, and not the close button
  // the restore would fall back to.
  await dialog(page).evaluate((d) => {
    d.tabIndex = -1;
    d.focus();
  });
  await expect.poll(focusedIsDialog).toBe(true);

  list = [linked(12), linked(13)];
  await refresh();
  await expect(dialogPills(page)).toHaveCount(2);
  await expect.poll(focusedIsDialog).toBe(true);

  list = [];
  await refresh();
  await expect(dialogPills(page)).toHaveCount(0);
  await expect.poll(focusedIsDialog).toBe(true);
});

for (const width of [1280, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations with a closing pull request in the dialog, ${scheme} at ${width}px`, async ({
      page,
    }) => {
      await mockBoard(page, () => [issue(1, [linked(12)])]);
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/issues.html');
      await openDialog(page);
      await expect(dialogPills(page)).toHaveCount(1);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
