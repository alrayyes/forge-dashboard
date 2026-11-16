import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The pills for checks, merge state, behind and auto-merge say what the forge
// reported, so while the forge can't be asked they say it is an earlier answer,
// with since-when. They ask the one rule a row's actions ask, and never the
// forge's name: both forges get the same words.
// https://github.com/alrayyes/forge-dashboard/issues/3994

function pr(forge: string) {
  return {
    forge,
    repo: 'example/app',
    number: 1,
    title: 'Pills',
    url: 'https://example.com/pull/1',
    author: 'someone',
    draft: false,
    ci: 'failure',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'conflicting',
    conflictConfirmed: true,
    behind: false,
    autoMergeEnabled: true,
    kind: 'regular',
    allowedActions: [{ action: 'close' }],
  };
}

// Out of date, with nothing else to say about the merge: a confirmed conflict
// would keep the chip off the row.
function behind(forge: string) {
  return {
    ...pr(forge),
    number: 2,
    title: 'Behind',
    updatedAt: new Date(Date.now() - 1000).toISOString(),
    ci: 'success',
    mergeStatus: 'mergeable',
    autoMergeEnabled: false,
    behind: true,
  };
}

async function open(page: Page, forge: string, reachable: boolean) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          reachable
            ? { forge, reachable: true, repoCount: 1 }
            : {
                forge,
                reachable: false,
                repoCount: 1,
                errorKind: 'unreachable',
                error: 'timeout',
                staleSince: new Date(Date.now() - 10 * 60_000).toISOString(),
              },
        ],
        pullRequests: [pr(forge), behind(forge)],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
}

const PILLS = [
  '.ci-pill',
  '.merge-pill',
  '.attr-chip.behind',
  '.attr-chip.auto-merge',
];

for (const forge of ['forgejo', 'github']) {
  test(`${forge}: while the forge can't be asked every state pill says it is an earlier answer, since when`, async ({
    page,
  }) => {
    await open(page, forge, false);
    const row = page.locator('#pr-rows > .row');
    for (const selector of PILLS) {
      const pill = row.locator(selector).first();
      await expect(pill, selector).toHaveAttribute(
        'data-claim',
        'carried_over',
      );
      await expect(pill, selector).toHaveAttribute(
        'title',
        /earlier answer from \d+m ago/,
      );
      // The pipeline pill is a button with a name of its own, so the words
      // belong in that name; the others say them in hidden text.
      if (selector === '.ci-pill')
        await expect(pill).toHaveAccessibleName(/earlier answer from \d+m ago/);
      else
        await expect(
          pill.locator('.sr-only', { hasText: 'earlier answer' }),
          selector,
        ).toHaveText(/earlier answer from \d+m ago/);
    }
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test(`${forge}: while the forge answers no pill claims anything is old`, async ({
    page,
  }) => {
    await open(page, forge, true);
    const row = page.locator('#pr-rows > .row');
    for (const selector of PILLS)
      await expect(row.locator(selector).first(), selector).toBeVisible();
    await expect(row.locator('[data-claim]')).toHaveCount(0);
  });
}
