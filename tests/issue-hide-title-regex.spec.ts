import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1593: "Hide titles matching (regex)" on the Issues page, next to the Hide
// Dependency Dashboard box. The filter state is saved per user, so this spec
// registers its own user rather than sharing the session.
// https://github.com/alrayyes/forge-dashboard/issues/1593

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `hide-title-regex-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Hide Title Regex');
}

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
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

// alrayyes/reports has only reports, by "bot", labelled "report".
const ISSUES = [
  issue(1, { title: 'Fix the login page' }),
  issue(2, { title: 'Add dark mode', author: 'claude' }),
  issue(3, {
    repo: 'alrayyes/reports',
    title: 'Weekly report for week 12',
    author: 'bot',
    labels: [{ name: 'report', color: '0366d6' }],
  }),
  issue(4, {
    repo: 'alrayyes/reports',
    title: 'WEEKLY REPORT for week 13',
    author: 'bot',
    labels: [{ name: 'report', color: '0366d6' }],
  }),
  issue(5, { title: 'Please read the weekly report format' }),
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
        pullRequests: [],
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/issues.html');
  await expect(page.locator('#issue-rows > .row')).toHaveCount(5);
}

const input = (page: Page) =>
  page.getByRole('textbox', { name: 'Hide titles matching (regex)' });
const note = (page: Page) => page.locator('#issue-hide-title-note');
const error = (page: Page) => page.locator('#issue-hide-title-regex-error');
const rows = (page: Page) => page.locator('#issue-rows > .row');
const choices = (page: Page, id: string) =>
  page
    .locator(`#${id} option`)
    .evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).textContent?.trim() ?? ''),
    );

test.describe('hide titles matching a pattern (#1593)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    await open(page);
  });

  test('the input sits beside the Hide Dependency Dashboard box and hides nothing while empty', async ({
    page,
  }) => {
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue('');
    await expect(note(page)).toBeHidden();
    await expect(error(page)).toBeHidden();
    const box = await page
      .locator('#issue-hide-dependency-dashboard')
      .boundingBox();
    const field = await input(page).boundingBox();
    expect(Math.abs((box?.y ?? 0) - (field?.y ?? 999))).toBeLessThan(40);
  });

  test('a pattern hides matching titles anywhere in the title, ignoring case, and the count and note follow', async ({
    page,
  }) => {
    await input(page).fill('weekly report');

    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#issue-count')).toHaveText('Showing 2 of 5');
    await expect(note(page)).toHaveText('3 hidden by this pattern');
    await expect(error(page)).toBeHidden();
    await expect(input(page)).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('an anchored pattern only hides titles that start that way', async ({
    page,
  }) => {
    await input(page).fill('^weekly report');

    await expect(rows(page)).toHaveCount(3);
    await expect(note(page)).toHaveText('2 hidden by this pattern');
  });

  test('pagination follows the hidden rows', async ({ page }) => {
    const many = [
      ...Array.from({ length: 27 }, (_, i) =>
        issue(100 + i, { title: `Task ${i}` }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        issue(200 + i, { title: `Weekly report ${i}` }),
      ),
    ];
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues: many,
          openIssueCount: many.length,
          repos: [],
          hiddenDrafts: 0,
        }),
      }),
    );
    await page.reload();
    await expect(rows(page)).toHaveCount(25);
    await expect(page.locator('#issue-pagination-pages')).toContainText('2');

    await input(page).fill('^Weekly');

    await expect(page.locator('#issue-count')).toHaveText('Showing 27 of 30');
    await expect(rows(page)).toHaveCount(25);
    await expect(note(page)).toHaveText('3 hidden by this pattern');
    await input(page).fill('^Task 1|^Weekly');
    await expect(rows(page)).toHaveCount(16);
    await expect(page.locator('#issue-pagination')).toBeHidden();
  });

  test('an invalid pattern shows a plain error, hides nothing and never throws', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await input(page).fill('(unclosed');

    await expect(error(page)).toHaveText("That pattern isn't valid.");
    await expect(input(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(input(page)).toHaveAttribute(
      'aria-describedby',
      'issue-hide-title-regex-error',
    );
    await expect(rows(page)).toHaveCount(5);
    await expect(note(page)).toBeHidden();

    await input(page).fill('^Weekly');
    await expect(error(page)).toBeHidden();
    await expect(input(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(rows(page)).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('a catastrophic pattern is refused at once and the page stays responsive', async ({
    page,
  }) => {
    await input(page).fill('(a+)+$');

    await expect(error(page)).toHaveText(
      'That pattern is too complex to check safely. Try a simpler one.',
    );
    await expect(input(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(input(page)).toHaveAttribute(
      'aria-describedby',
      'issue-hide-title-regex-error',
    );
    await expect(rows(page)).toHaveCount(5);
    await input(page).fill('(a+){5}$');
    await expect(error(page)).toContainText('too complex');
    await expect(rows(page)).toHaveCount(5);
    const started = Date.now();
    await page.evaluate(() => 1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('the pattern survives a reload, and Clear filters resets it', async ({
    page,
  }) => {
    await input(page).fill('^Weekly report');
    await expect(rows(page)).toHaveCount(3);

    await page.reload();
    await expect(input(page)).toHaveValue('^Weekly report');
    await expect(rows(page)).toHaveCount(3);
    await expect(note(page)).toHaveText('2 hidden by this pattern');

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(input(page)).toHaveValue('');
    await expect(rows(page)).toHaveCount(5);
    await expect(note(page)).toBeHidden();
  });

  test('the pattern is saved to the server with the rest of the filter state', async ({
    page,
  }) => {
    const saved = page.waitForRequest(
      (r) =>
        r.url().includes('/api/settings/filter-state') &&
        r.method() === 'PUT' &&
        (r.postData() ?? '').includes('hideTitleRegex'),
    );
    await input(page).fill('^Weekly');
    const body = JSON.parse((await saved).postData() ?? '{}');
    expect(body.issue.hideTitleRegex).toBe('^Weekly');
  });

  test('repo, author and label choices follow the rule', async ({ page }) => {
    expect(await choices(page, 'shared-repo-select')).toContain(
      'alrayyes/reports',
    );
    expect(await choices(page, 'shared-author-select')).toContain('bot');
    expect(await choices(page, 'shared-label-select')).toContain('report');

    await input(page).fill('^Weekly report|^Weekly');

    await expect(rows(page)).toHaveCount(3);
    expect(await choices(page, 'shared-repo-select')).not.toContain(
      'alrayyes/reports',
    );
    expect(await choices(page, 'shared-author-select')).not.toContain('bot');
    expect(await choices(page, 'shared-label-select')).not.toContain('report');

    await input(page).fill('');
    expect(await choices(page, 'shared-repo-select')).toContain(
      'alrayyes/reports',
    );
  });

  test('at 360px the input is shown and works', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(input(page)).toBeVisible();
    const box = await input(page).boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    await input(page).fill('weekly');
    await expect(rows(page)).toHaveCount(2);
    await expect
      .poll(async () => (await input(page).boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
  });

  test('the error line sits right under the field, before the count note', async ({
    page,
  }) => {
    await input(page).fill('(unclosed');
    const field = await input(page).boundingBox();
    const err = await error(page).boundingBox();
    expect(
      (err?.y ?? 0) - ((field?.y ?? 0) + (field?.height ?? 0)),
    ).toBeLessThan(40);
    const order = await page.evaluate(
      () =>
        document
          .getElementById('issue-hide-title-regex-error')
          ?.compareDocumentPosition(
            document.getElementById('issue-hide-title-note') as Node,
          ) ?? 0,
    );
    // 4 is DOCUMENT_POSITION_FOLLOWING: the note comes after the error.
    expect(order & 4).toBeTruthy();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`axe, ${scheme}`, () => {
      const scan = (page: Page) =>
        new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();

      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
      });

      test('with the input shown and a pattern applied', async ({ page }) => {
        await input(page).fill('^Weekly');
        await expect(note(page)).toBeVisible();
        expect((await scan(page)).violations).toEqual([]);
      });

      test('with the error shown', async ({ page }) => {
        await input(page).fill('(unclosed');
        await expect(error(page)).toBeVisible();
        expect((await scan(page)).violations).toEqual([]);
      });
    });
  }
});
