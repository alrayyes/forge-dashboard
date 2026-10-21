import { expect, type Page, type Route } from '@playwright/test';
import { choicesOf } from './label-filter-helper';
import { test } from './server-fixture';

// The edges of #1427 the first review of its fix found: the choices must match
// the list on screen when a poll only renames a pull request, when a held list
// legitimately emptied, when a held list lands by a sort change, and when a
// saved pick is not on offer.
// https://github.com/alrayyes/forge-dashboard/issues/2196

declare global {
  interface Window {
    __push: (data: unknown) => void;
    __titleRebuilds: number;
  }
}

const NOW = Date.now();

function pr(number: number, author: string, title = `Pull request ${number}`) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://example.com/pull/${number}`,
    author,
    draft: false,
    ci: 'success',
    labels: [{ name: 'bug', color: 'ededed' }],
    createdAt: new Date(NOW - number * 60_000).toISOString(),
    updatedAt: new Date(NOW - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    kind: 'feature',
    allowedActions: [],
  };
}

const ONE = [pr(1, 'alrayyes')];
const TWO = [...ONE, pr(2, 'claude')];

const snapshot = (prs: unknown[]) => ({
  generatedAt: new Date().toISOString(),
  forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
  pullRequests: prs,
  issues: [],
});

async function open(
  page: Page,
  initial: unknown[] = ONE,
  gate?: Promise<void>,
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
  await page.route('**/api/dashboard', async (route: Route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(initial)),
    });
  });
  await page.goto('/pull-requests.html');
  if (gate) return;
  await expect(page.locator('#pr-rows > .row')).toHaveCount(initial.length);
  await page.waitForFunction(
    () =>
      (window as unknown as { __es?: { onmessage: unknown } }).__es
        ?.onmessage != null,
  );
}

const push = (page: Page, prs: unknown[]) =>
  page.evaluate((data) => window.__push(data), snapshot(prs));

const choices = async (page: Page, id: string) =>
  (await choicesOf(page, id)).filter((text) => !text.startsWith('All'));

const titleSuggestions = (page: Page) =>
  page
    .locator('#shared-title-options option')
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

test('a poll that only renames a pull request refreshes the Title suggestions', async ({
  page,
}) => {
  await open(page);
  expect(await titleSuggestions(page)).toEqual(['Pull request 1']);

  // Same updatedAt, same everything else: only the title differs.
  await push(page, [{ ...ONE[0], title: 'Renamed pull request' }]);
  await expect(page.locator('#pr-rows .row').first()).toContainText(
    'Renamed pull request',
  );

  await expect
    .poll(() => titleSuggestions(page))
    .toEqual(['Renamed pull request']);
});

test('a rename leaves the suggestions alone while the Title box has focus', async ({
  page,
}) => {
  await open(page);
  await page.locator('input[data-col="title"]').first().focus();

  await push(page, [{ ...ONE[0], title: 'Renamed pull request' }]);
  await expect(page.locator('#pr-rows .row').first()).toContainText(
    'Renamed pull request',
  );

  expect(await titleSuggestions(page)).toEqual(['Pull request 1']);
});

test('a held list that emptied offers no choices from the newer snapshot', async ({
  page,
}) => {
  // A phone, where the Filters sheet is a modal that holds the board.
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page);
  await push(page, []);
  await expect(page.locator('#pr-rows > .row')).toHaveCount(0);

  await page.locator('#filters-button').click();
  await expect(page.locator('#filter-sheet')).toBeVisible();
  await push(page, TWO);
  // The sheet holds the list: it still shows nothing.
  await expect(page.locator('#pr-rows > .row')).toHaveCount(0);

  expect(await choices(page, 'shared-author-select')).toEqual([]);
  expect(await choices(page, 'shared-repo-select')).toEqual([]);
});

test('a pick the sort-landed list lacks is cleared once, and the rows agree', async ({
  page,
}) => {
  await open(page, TWO);
  await page.locator('#shared-author-select').selectOption('claude');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pause live updates' }).click();
  await push(page, ONE);
  await expect(page.locator('#updates-paused-hint')).toBeVisible();

  await page.evaluate(() => {
    window.__titleRebuilds = 0;
    const list = document.getElementById('shared-title-options');
    if (!list) throw new Error('no title datalist');
    new MutationObserver((records) => {
      for (const r of records)
        if (r.removedNodes.length > 0) window.__titleRebuilds += 1;
    }).observe(list, { childList: true });
  });
  await page.getByLabel('Sort pull requests by').selectOption('created');

  await expect(page.locator('#shared-author-select')).toHaveValue('');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
  await expect(page.locator('#pr-rows .row').first()).toContainText(
    'Pull request 1',
  );
  // Let the observer deliver and any second offer run, then count.
  const rebuilds = await page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(window.__titleRebuilds)),
        ),
      ),
  );
  expect(rebuilds).toBe(1);
});

test('a saved pick the first list lacks is set aside and the list shows', async ({
  page,
}) => {
  await page.route('**/api/settings/filter-state', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        shared: { author: 'ghost' },
        pr: {},
        issue: {},
        view: {},
      }),
    });
  });
  await open(page);

  await expect(page.locator('#shared-author-select')).toHaveValue('');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(1);
  expect(await choices(page, 'shared-author-select')).toEqual(['alrayyes']);
});

test('a first snapshot held by the open Filters sheet still offers its choices', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await open(page, TWO, gate);
  // Closing the sheet lifts a hold that has nothing waiting; opening it again
  // holds the list for the snapshot that is still on its way.
  await page.locator('#filters-button').click();
  await expect(page.locator('#filter-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#filter-sheet')).not.toBeVisible();
  await page.locator('#filters-button').click();
  await expect(page.locator('#filter-sheet')).toBeVisible();

  release();

  // The sheet holds the list, so nothing is drawn yet, and nothing has
  // landed for the choices to follow: they come from the snapshot.
  await expect
    .poll(() => choices(page, 'shared-author-select'))
    .toEqual(['alrayyes', 'claude']);
  await expect(page.locator('#pr-rows > .row')).toHaveCount(0);
});
