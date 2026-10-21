import { expect, type Page, type Route } from '@playwright/test';
import { choicesOf } from './label-filter-helper';
import { test } from './server-fixture';

// #1427: the Author, Repo and Label choices name only what the list on screen
// has. While the list waits (updates paused, or the pointer resting on it) a
// newer snapshot can hold a pull request the list does not show yet, and its
// author must not be offered: picking it would show an empty list.
// https://github.com/alrayyes/forge-dashboard/issues/1427

declare global {
  interface Window {
    __push: (data: unknown) => void;
  }
}

function pr(number: number, author: string, repo: string, label: string) {
  return {
    forge: 'github',
    repo,
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author,
    draft: false,
    ci: 'success',
    labels: [{ name: label, color: 'ededed' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    kind: 'feature',
    allowedActions: [],
  };
}

const SHOWN = [pr(1, 'alrayyes', 'alrayyes/app', 'bug')];
const NEWER = [...SHOWN, pr(2, 'claude', 'alrayyes/lib', 'docs')];

function issue(number: number, author: string, repo: string, label: string) {
  return {
    forge: 'github',
    repo,
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author,
    labels: [{ name: label, color: 'ededed' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
  };
}

const ISSUES_SHOWN = [issue(1, 'alrayyes', 'alrayyes/app', 'bug')];
const ISSUES_NEWER = [
  ...ISSUES_SHOWN,
  issue(2, 'claude', 'alrayyes/lib', 'docs'),
];

const snapshot = (prs: unknown[], issues: unknown[] = []) => ({
  generatedAt: new Date().toISOString(),
  forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
  pullRequests: prs,
  issues,
});

async function open(
  page: Page,
  path = '/pull-requests.html',
  initial: unknown[] = SHOWN,
) {
  await page.addInitScript(() => {
    class StubEventSource {
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor() {
        (window as unknown as { __es: StubEventSource }).__es = this;
      }
      close() {}
      addEventListener() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource =
      StubEventSource;
    window.__push = (data) =>
      (window as unknown as { __es: StubEventSource }).__es.onmessage?.({
        data: JSON.stringify(data),
      });
  });
  await page.route('**/api/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        path === '/issues.html'
          ? snapshot([], ISSUES_SHOWN)
          : snapshot(initial),
      ),
    }),
  );
  await page.goto(path);
  await expect(
    page.locator(
      path === '/issues.html' ? '#issue-rows > .row' : '#pr-rows > .row',
    ),
  ).toHaveCount(path === '/issues.html' ? 1 : initial.length);
  await page.waitForFunction(
    () =>
      (window as unknown as { __es?: { onmessage: unknown } }).__es
        ?.onmessage != null,
  );
}

const choices = async (page: Page, id: string) =>
  (await choicesOf(page, id)).filter((text) => !text.startsWith('All'));

test('choices stay with the list on screen while updates are paused', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Pause live updates' }).click();

  await page.evaluate((data) => window.__push(data), snapshot(NEWER));
  await expect(page.locator('#updates-paused-hint')).toBeVisible();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);

  expect(await choices(page, 'shared-author-select')).toEqual(['alrayyes']);
  expect(await choices(page, 'shared-repo-select')).toEqual(['alrayyes/app']);
  expect(await choices(page, 'shared-label-filter')).toEqual(['bug']);

  // Resuming lands the new row, and its choices arrive with it.
  await page.getByRole('button', { name: 'Pause live updates' }).click();
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  expect(await choices(page, 'shared-author-select')).toEqual([
    'alrayyes',
    'claude',
  ]);
});

test('choices follow the list when a held list lands by a sort change', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Pause live updates' }).click();
  await page.evaluate((data) => window.__push(data), snapshot(NEWER));
  await expect(page.locator('#updates-paused-hint')).toBeVisible();

  // Sorting applies what waited, and the choices describe it.
  await page.getByLabel('Sort pull requests by').selectOption('created');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  expect(await choices(page, 'shared-author-select')).toEqual([
    'alrayyes',
    'claude',
  ]);
});

test('choices follow the list when the pointer leaves a held list', async ({
  page,
}) => {
  await open(page);
  await page.locator('#pr-rows .row').first().hover();
  await page.evaluate((data) => window.__push(data), snapshot(NEWER));
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
  expect(await choices(page, 'shared-author-select')).toEqual(['alrayyes']);

  await page.mouse.move(2, 2);
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
  expect(await choices(page, 'shared-author-select')).toEqual([
    'alrayyes',
    'claude',
  ]);
});

test('the Issues page keeps its choices with the list while updates are paused', async ({
  page,
}) => {
  await open(page, '/issues.html');
  await page.getByRole('button', { name: 'Pause live updates' }).click();
  await page.evaluate(
    (data) => window.__push(data),
    snapshot([], ISSUES_NEWER),
  );
  await expect(page.locator('#updates-paused-hint')).toBeVisible();
  await expect(page.locator('#issue-rows > .row')).toHaveCount(1);

  expect(await choices(page, 'shared-author-select')).toEqual(['alrayyes']);
  expect(await choices(page, 'shared-repo-select')).toEqual(['alrayyes/app']);

  await page.getByRole('button', { name: 'Pause live updates' }).click();
  await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
  expect(await choices(page, 'shared-author-select')).toEqual([
    'alrayyes',
    'claude',
  ]);
});

test('a saved pick only the held list has is kept when the saved copy arrives', async ({
  page,
}) => {
  const endpoint = '/api/settings/filter-state';
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${endpoint}`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await gate;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        shared: { author: 'claude' },
        pr: {},
        issue: {},
        view: { paused: '1' },
      }),
    });
  });
  await open(page);
  await page.getByRole('button', { name: 'Pause live updates' }).click();
  await page.evaluate((data) => window.__push(data), snapshot(NEWER));
  await expect(page.locator('#updates-paused-hint')).toBeVisible();

  release();

  // The copy lands the held list, claude's pull request is in it, so the pick
  // stays and is not saved as cleared.
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
  await expect(page.locator('#shared-author-select')).toHaveValue('claude');
});

test('a pick the landed list no longer offers is cleared and the list shows again', async ({
  page,
}) => {
  await open(page, '/pull-requests.html', NEWER);
  await page.locator('#shared-author-select').selectOption('claude');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pause live updates' }).click();

  await page.evaluate((data) => window.__push(data), snapshot(SHOWN));
  await expect(page.locator('#updates-paused-hint')).toBeVisible();
  await page.getByRole('button', { name: 'Pause live updates' }).click();

  await expect(page.locator('#shared-author-select')).toHaveValue('');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
});

test('the Title suggestions follow the list that lands', async ({ page }) => {
  await open(page);
  await page.evaluate((data) => window.__push(data), snapshot(NEWER));
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);

  await expect
    .poll(() =>
      page
        .locator('#shared-title-options option')
        .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)),
    )
    .toEqual(['Pull request 1', 'Pull request 2']);
});
