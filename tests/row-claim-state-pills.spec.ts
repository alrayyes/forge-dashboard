import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { type Forge, forgeHealth } from './forge-health-helper';
import { rateLimit } from './rate-limit-mock';
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
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
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

const down = (forge: Forge) =>
  forgeHealth(forge, {
    reachable: false,
    errorKind: 'unreachable',
    error: 'timeout',
    staleSince: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
const up = (forge: Forge) => forgeHealth(forge);
// Rows from the last run, shown before the forge has been asked this start.
const starting = (forge: Forge) =>
  forgeHealth(forge, {
    reachable: false,
    starting: true,
    staleSince: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
const limited = (forge: Forge) => ({
  ...up(forge),
  rateLimitREST: rateLimit(
    5000,
    0,
    new Date(Date.now() + 20 * 60_000).toISOString(),
  ),
});

async function openWith(
  page: Page,
  forges: Record<string, unknown>[],
  pullRequests: Record<string, unknown>[],
) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges,
        pullRequests,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(
    pullRequests.length,
  );
}

async function open(page: Page, forge: Forge, reachable: boolean) {
  await openWith(
    page,
    [reachable ? up(forge) : down(forge)],
    [pr(forge), behind(forge)],
  );
}

const PILLS = [
  '.ci-pill',
  '.merge-pill',
  '.attr-chip.behind',
  '.attr-chip.auto-merge',
];

for (const forge of ['forgejo', 'github'] as const) {
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

// Each pill says it is an earlier answer, with since-when, in its data-claim
// and title. The starting-host test also checks the hidden text.
async function expectEarlier(page: Page, since: RegExp) {
  const row = page.locator('#pr-rows > .row');
  for (const selector of PILLS) {
    const pill = row.locator(selector).first();
    await expect(pill, selector).toHaveAttribute('data-claim', 'carried_over');
    await expect(pill, selector).toHaveAttribute('title', since);
  }
}

for (const forge of ['forgejo', 'github'] as const) {
  test(`${forge}: a host that has not been asked since the app started is an earlier answer too`, async ({
    page,
  }) => {
    await openWith(page, [starting(forge)], [pr(forge), behind(forge)]);
    await expectEarlier(page, /earlier answer from \d+m ago/);
    // The reason is the claim rule's, not the unreachable banner's wording.
    await expect(
      page
        .locator('#pr-rows > .row')
        .locator('.attr-chip.behind')
        .first()
        .locator('.sr-only'),
    ).toHaveText(/earlier answer from \d+m ago/);
  });

  // A row names its forge kind, not its host, so while any host of the kind
  // can't be asked the row may be one of that host's earlier answers. The
  // order of the hosts changes nothing.
  for (const [name, forges] of [
    ['down first', [down(forge), up(forge)]],
    ['down last', [up(forge), down(forge)]],
  ] as const) {
    test(`${forge}: with one host down and one up (${name}) the pills are still an earlier answer`, async ({
      page,
    }) => {
      await openWith(page, [...forges], [pr(forge), behind(forge)]);
      await expectEarlier(page, /earlier answer from \d+m ago/);
    });
  }

  test(`${forge}: another kind's host being down says nothing about these rows`, async ({
    page,
  }) => {
    const other = forge === 'github' ? 'forgejo' : 'github';
    await openWith(page, [up(forge), down(other)], [pr(forge), behind(forge)]);
    await expect(
      page.locator('#pr-rows > .row .ci-pill').first(),
    ).toBeVisible();
    await expect(page.locator('#pr-rows > .row [data-claim]')).toHaveCount(0);
  });
}

// The queue cell offers an action for the rate limit's reset, so it is only
// there while the row is a fresh answer. It reads the same claim the pills do.
test.describe('the queue cell', () => {
  const queueable = () => ({
    ...behind('github'),
    allowedActions: [{ action: 'close' }, { action: 'update_branch' }],
  });
  const queue = (page: Page) =>
    page.locator('#pr-rows > .row').getByRole('button', { name: /^Queue / });

  test('is offered on a limited host that answers, with no pill called old', async ({
    page,
  }) => {
    await openWith(page, [limited('github')], [queueable()]);
    await expect(queue(page)).toHaveCount(1);
    await expect(page.locator('#pr-rows > .row [data-claim]')).toHaveCount(0);
  });

  for (const [name, other] of [
    ['unreachable', down('github')],
    ['starting', starting('github')],
  ] as const) {
    test(`is not offered while another host of the kind is ${name}, and the pills say why`, async ({
      page,
    }) => {
      await openWith(page, [limited('github'), other], [queueable()]);
      await expect(queue(page)).toHaveCount(0);
      await expect(
        page.locator('#pr-rows > .row .ci-pill').first(),
      ).toHaveAttribute('data-claim', 'carried_over');
    });
  }
});
