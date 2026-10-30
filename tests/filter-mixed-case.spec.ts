import { expect, type Page, type Route } from '@playwright/test';
import {
  labelButton,
  pickButton,
  pickedLabels,
  pickedValues,
  pickOnly,
  toggleLabels,
} from './label-filter-helper';
import { test } from './server-fixture';

// #1620: an author or label with capitals ("Ryan", "Bug") is saved lowercase,
// and used to be cleared the moment it was picked because the rebuilt select
// compared exactly. The pick must stay, shown as written, and survive leaving
// the page and coming back. The saved state is on the server, so this spec
// registers its own.
// https://github.com/alrayyes/forge-dashboard/issues/1620

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    author: 'Ryan',
    labels: [{ name: 'Bug', color: 'd73a4a' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const ISSUES = [
  issue(1),
  issue(2, { author: 'sam', labels: [{ name: 'docs', color: '0366d6' }] }),
  issue(3, { author: 'Ryan', labels: [] }),
];

async function open(page: Page, url: string) {
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
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
  await page.goto(url);
}

const issueRows = (page: Page) => page.locator('#issue-rows > .row');

test.describe('a pick with capitals stays picked (#1620)', () => {
  test.beforeEach(async ({ page }) => {
    await open(page, '/issues.html');
    await expect(issueRows(page)).toHaveCount(3);
  });

  for (const [control, value, saved, kept] of [
    ['author', 'Ryan', 'github:ryan', 2],
  ] as const) {
    test(`the ${control} pick ${value} is kept, and is still set after a full load`, async ({
      page,
    }) => {
      await pickOnly(page, control, saved);
      await expect(issueRows(page)).toHaveCount(kept);
      // The page rebuilds its choices after a pick; the pick must outlast that.
      await expect.poll(() => pickedValues(page, control)).toEqual([saved]);
      await expect(pickButton(page, control)).toHaveText(value);

      await open(page, '/issues.html');
      await expect.poll(() => pickedValues(page, control)).toEqual([saved]);
      await expect(issueRows(page)).toHaveCount(kept);
    });
  }

  test('the label pick Bug is kept, shown as written, and is still set after a full load', async ({
    page,
  }) => {
    await toggleLabels(page, 'Bug');
    await expect(issueRows(page)).toHaveCount(1);
    await expect(labelButton(page)).toHaveText('Bug');
    expect(await pickedLabels(page)).toEqual(['bug']);

    await open(page, '/issues.html');
    await expect(labelButton(page)).toHaveText('Bug');
    await expect(issueRows(page)).toHaveCount(1);
  });
});
