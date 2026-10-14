import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { settle } from './settle-helper';

// #827, #718: the issues page holds its list steady during a refresh. A
// snapshot that would add, remove or move rows is held behind an "N updates
// available" bar while you're scrolled below the top or a control in the
// list has focus; a row whose own content changed updates in place; a
// snapshot with no change renders nothing.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `issues-steady-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Steady Issues');
}

interface MockIssue {
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  labels: { name: string; color: string }[];
  createdAt: string;
  updatedAt: string;
  housekeeping?: boolean;
}

function makeIssue(number: number, overrides: Partial<MockIssue> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'alrayyes',
    labels: [],
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: `2026-10-02T10:${String(59 - (number % 60)).padStart(2, '0')}:00Z`,
    ...overrides,
  };
}

// Enough rows that the page scrolls at the default viewport.
const BASE = Array.from({ length: 24 }, (_, i) => makeIssue(i + 1));

function makePR(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'alrayyes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-02T10:00:00Z',
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    allowedActions: [],
    ...overrides,
  };
}

function snapshot(
  issues: MockIssue[],
  pullRequests: ReturnType<typeof makePR>[] = [],
) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests,
    issues,
    repos: [],
    hiddenDrafts: 0,
  };
}

async function open(
  page: Page,
  issues: MockIssue[] = BASE,
  pullRequests: ReturnType<typeof makePR>[] = [],
) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
  // Only the pushes below reach the page: the real stream would add its own.
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(issues, pullRequests)),
    }),
  );
  await page.goto('/issues.html');
  await expect(page.locator('#issue-rows > .row')).toHaveCount(
    // A bot's housekeeping issue is hidden by default.
    Math.min(25, issues.filter((i) => !i.housekeeping).length),
  );
}

async function push(
  page: Page,
  issues: MockIssue[],
  pullRequests: ReturnType<typeof makePR>[] = [],
) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify(snapshot(issues, pullRequests)),
  );
}

async function tagRows(page: Page) {
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#issue-rows > .row');
    for (let i = 0; i < rows.length; i++)
      (rows[i] as unknown as { __tag: number }).__tag = i;
  });
}

const tags = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#issue-rows > .row')].map(
      (row) => (row as unknown as { __tag?: number }).__tag ?? null,
    ),
  );

const bar = (page: Page) => page.locator('#updates-count');
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

async function scrollDown(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => scrollY(page)).toBeGreaterThan(300);
}

test.describe('steady issues refresh (#827, #718)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  // #1198: the bar on the issues page counts issue rows only. Pull request
  // changes in the same snapshot don't move anything in the issues list, so
  // they must not raise it, however the list is being held.
  test('a snapshot that changes only pull requests raises no bar on the issues page', async ({
    page,
  }) => {
    await open(page, BASE, [makePR(1), makePR(2)]);
    await scrollDown(page);

    // A pull request added, one removed, one changed, one moved.
    await push(page, BASE, [
      makePR(2, { title: 'Retitled' }),
      makePR(3, { updatedAt: '2026-10-03T10:00:00Z' }),
    ]);
    await expect(bar(page)).toHaveText('');
    await expect(page.locator('#show-updates-button')).toBeHidden();
  });

  test('the same holds while updates are paused', async ({ page }) => {
    await open(page, BASE, [makePR(1)]);
    await page.locator('#pause-updates-button').click();

    await push(page, BASE, [makePR(1), makePR(2)]);
    await expect(bar(page)).toHaveText('');
    await expect(page.locator('#show-updates-button')).toBeHidden();
  });

  // #1198: neither does a change to an issue the list isn't showing, such as
  // Renovate's Dependency Dashboard (hidden by default), which Renovate
  // rewrites on every run and so keeps moving to the top of the list.
  test('a hidden housekeeping issue moving raises no bar', async ({ page }) => {
    const dashboard = (updatedAt: string) =>
      makeIssue(999, {
        title: 'Dependency Dashboard',
        updatedAt,
        housekeeping: true,
      });
    await open(page, [dashboard('2026-09-01T10:00:00Z'), ...BASE]);
    await expect(page.locator('#issue-rows')).not.toContainText(
      'Dependency Dashboard',
    );
    await scrollDown(page);

    await push(page, [dashboard('2026-10-09T10:00:00Z'), ...BASE]);
    await expect(bar(page)).toHaveText('');
    await expect(page.locator('#show-updates-button')).toBeHidden();
  });

  test('an issue the filters hide being added raises no bar', async ({
    page,
  }) => {
    await open(page);
    await page
      .locator('.filter-bar .col-filter[data-col="title"]')
      .fill('Issue 1');
    await scrollDown(page);

    await push(page, [makeIssue(100, { title: 'Something else' }), ...BASE]);
    await expect(bar(page)).toHaveText('');
    await expect(page.locator('#show-updates-button')).toBeHidden();
  });

  test('an issue the filters show being added still raises the bar', async ({
    page,
  }) => {
    await open(page);
    await page
      .locator('.filter-bar .col-filter[data-col="title"]')
      .fill('Issue 1');
    await scrollDown(page);

    await push(page, [makeIssue(101, { title: 'Issue 1 again' }), ...BASE]);
    await expect(bar(page)).toHaveText('1 update available');
    await expect(bar(page)).toHaveAttribute('role', 'status');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('an issue added alongside a pull request change is counted as the one issue', async ({
    page,
  }) => {
    await open(page, BASE, [makePR(1)]);
    await scrollDown(page);

    await push(page, [makeIssue(100), ...BASE], [makePR(1), makePR(2)]);
    await expect(bar(page)).toHaveText('1 update available');
  });

  test('a snapshot with no change renders no issue row again', async ({
    page,
  }) => {
    await open(page);
    await tagRows(page);

    await push(page, BASE);
    await push(page, BASE);
    await settle(page);

    expect(await tags(page)).toEqual(BASE.map((_, i) => i));
    await expect(bar(page)).toHaveText('');
  });

  test('at the top with nothing focused, an added issue appears at once', async ({
    page,
  }) => {
    await open(page);

    await push(page, [makeIssue(100, { title: 'Brand new' }), ...BASE]);

    await expect(page.locator('#issue-rows')).toContainText('Brand new');
    await expect(bar(page)).toHaveText('');
  });

  test('scrolled below the top, a new issue is held behind the bar and the scroll position stays', async ({
    page,
  }) => {
    await open(page);
    await tagRows(page);
    await scrollDown(page);
    const before = await scrollY(page);

    await push(page, [makeIssue(100, { title: 'Brand new' }), ...BASE]);

    await expect(bar(page)).toHaveText('1 update available');
    await expect(bar(page)).toHaveAttribute('role', 'status');
    await expect(page.locator('#issue-rows')).not.toContainText('Brand new');
    expect(await tags(page)).toEqual(BASE.map((_, i) => i));
    expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Show updates' }).click();
    await expect(page.locator('#issue-rows')).toContainText('Brand new');
    await expect(bar(page)).toHaveText('');
  });

  test('scrolled below the top, a removed issue and a reordering are held too', async ({
    page,
  }) => {
    await open(page);
    await scrollDown(page);

    const [first, second, ...rest] = BASE;
    await push(page, [second, first, ...rest.slice(0, -1)]);

    await expect(bar(page)).not.toHaveText('');
    await expect(page.locator('#issue-rows > .row').first()).toContainText(
      'Issue 1',
    );
  });

  test('with focus inside the list, changes are held until focus leaves', async ({
    page,
  }) => {
    await open(page);
    await page.locator('#issue-rows > .row a').first().focus();

    await push(page, [makeIssue(100, { title: 'Brand new' }), ...BASE]);
    await expect(bar(page)).toHaveText('1 update available');
    await expect(page.locator('#issue-rows')).not.toContainText('Brand new');

    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(page.locator('#issue-rows')).toContainText('Brand new');
    await expect(bar(page)).toHaveText('');
  });

  test('a row whose own content changed updates in place, even while scrolled', async ({
    page,
  }) => {
    await open(page);
    await tagRows(page);
    await scrollDown(page);
    const before = await scrollY(page);

    const changed = BASE.map((i) =>
      i.number === 3 ? { ...i, title: 'Issue 3, renamed' } : i,
    );
    await push(page, changed);

    await expect(page.locator('#issue-rows')).toContainText('Issue 3, renamed');
    await expect(bar(page)).toHaveText('');
    // Only that row was replaced; every other row is the same node.
    const t = await tags(page);
    expect(t.filter((x) => x === null)).toHaveLength(1);
    expect(t.filter((x) => x !== null)).toHaveLength(BASE.length - 1);
    expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(1);
  });

  test('pausing live updates holds structural changes at the top too', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: 'Pause live updates' }).click();

    await push(page, [makeIssue(100, { title: 'Brand new' }), ...BASE]);

    await expect(bar(page)).toHaveText('1 update available');
    await expect(page.locator('#issue-rows')).not.toContainText('Brand new');
  });

  test('the sort control orders issues, and only a change to it or Show updates moves rows', async ({
    page,
  }) => {
    await open(page, [
      makeIssue(1, { repo: 'alrayyes/b-repo' }),
      makeIssue(2, { repo: 'alrayyes/a-repo' }),
    ]);

    await page.locator('#pr-sort-select').selectOption('repo');
    await expect(page.locator('#issue-rows > .row').first()).toContainText(
      'a-repo',
    );
  });

  for (const [name, size] of [
    ['desktop', { width: 1280, height: 800 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    test(`the updates bar has no axe violations while showing, at ${name} width`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page);
      await scrollDown(page);
      await push(page, [makeIssue(100, { title: 'Brand new' }), ...BASE]);
      await expect(bar(page)).toHaveText('1 update available');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
