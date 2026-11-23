import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// #4477: a pill in an issue pop-up's Related band that names a merged or
// closed pull request the board no longer lists opens that pull request's
// pop-up, as a pill for an open one does. The dialog never closes with
// nothing shown. Mocks /api/v1/dashboard and the details endpoints only and
// writes no saved state.
//
// #4492: the same holds from a pill in a pull request pop-up's own Related
// band, and for a merged pull request in a repository the dashboard doesn't
// track, which is reached by a reference in the text instead of a pill.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';
const FOREIGN = 'alrayyes/elsewhere';

const issue = {
  forge: 'github',
  repo: REPO,
  number: 1,
  title: 'Issue 1',
  url: 'https://example.com/issues/1',
  author: 'ryankes',
  labels: [{ name: 'bug' }],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests: [],
};

const reference = (number: number, over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Item ${number}`,
  url: `https://example.com/${REPO}/pull/${number}`,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  kind: 'pullRequest',
  state: 'merged',
  direction: 'incoming',
  relation: 'mentions',
  tracked: true,
  ...over,
});

const issueRef = (relation: string) => ({
  kind: 'issue',
  state: 'open',
  direction: 'outgoing',
  relation,
  url: `https://example.com/${REPO}/issues/1`,
  pageUrl: `/issues.html?issue=github/${REPO}/1`,
});

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const thread = (text: string) => ({
  description: {
    text,
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
});

// 7 is merged, 8 closed, 9 is open and listed on the board.
const board = [
  {
    forge: 'github',
    repo: REPO,
    number: 9,
    title: 'Pull request 9',
    url: 'https://example.com/pull/9',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: ago(60),
    updatedAt: ago(5),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    closesIssues: [],
  },
];

async function open(page: Page, unreadable = false) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: board,
        issues: [issue],
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...thread('Board pull request.'),
        releaseNotes: null,
      }),
    }),
  );
  await page.route('**/api/v1/issues/details*', (route: Route) => {
    const number = Number(
      new URL(route.request().url()).searchParams.get('number'),
    );
    if (number === 1)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...thread(`The ticket. See ${FOREIGN}#50 and ${FOREIGN}#51.`),
          kind: 'issue',
          state: 'open',
          references: [
            reference(7, { relation: 'mentions' }),
            reference(8, { relation: 'refs', state: 'closed' }),
            reference(6, { relation: 'closes' }),
            reference(9, { state: 'open', relation: 'mentions' }),
            reference(40, { relation: 'mentions' }),
            reference(41, { relation: 'mentions' }),
            reference(11, { direction: 'outgoing', relation: 'closes' }),
            reference(12, { direction: 'outgoing', relation: 'refs' }),
            reference(13, { direction: 'outgoing', relation: 'mentions' }),
          ],
        }),
      });
    if (number >= 20 && number <= 22)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...thread(`Issue ${number}.`),
          kind: 'issue',
          state: 'open',
          references: [],
        }),
      });
    if (unreadable && number === 7)
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'the forge could not be reached' }),
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...thread(`Pull request ${number}, read from the forge.`),
        kind: 'pullRequest',
        state: 'closed',
        // What the pull request itself refers to, and one thing that refers
        // to it, which a pull request's band leaves out.
        references:
          number === 41 || number === 51
            ? // Eight outgoing mentions: more than a row shows.
              Array.from({ length: 8 }, (_, i) =>
                reference(60 + i, {
                  direction: 'outgoing',
                  relation: 'mentions',
                }),
              )
            : number === 7
              ? [
                  reference(22, issueRef('mentions')),
                  reference(20, issueRef('closes')),
                  reference(21, issueRef('refs')),
                  reference(30, { relation: 'mentions' }),
                  // Pull requests it refers to, one merged and one closed.
                  reference(31, {
                    direction: 'outgoing',
                    relation: 'mentions',
                  }),
                  reference(8, {
                    direction: 'outgoing',
                    relation: 'refs',
                    state: 'closed',
                  }),
                ]
              : [],
        pullRequest: {
          title: `Merged change ${number}`,
          state: number === 8 ? 'closed' : number === 51 ? 'open' : 'merged',
          author: null,
        },
      }),
    });
  });
  await page.goto('/issues.html');
  await page
    .locator('#issue-rows .row')
    .first()
    .locator('button.title')
    .click();
  await expect(issueDialog(page)).toBeVisible();
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const originRow = (page: Page) =>
  page.locator('#issue-rows .row').first().locator('button.title');
const pill = (page: Page, group: string, number: number) =>
  issueDialog(page)
    .getByRole('group', { name: group })
    .locator('.linked-pr', { hasText: `#${number}` });

for (const [group, number] of [
  ['Mentioned by', 7],
  ['Referenced by', 8],
  ['Closed by', 6],
] as const) {
  test(`a ${group} pill to a pull request off the board opens its pop-up`, async ({
    page,
  }) => {
    await open(page);
    const trigger = pill(page, group, number);
    await trigger.click();

    await expect(prDialog(page)).toBeVisible();
    await expect(
      prDialog(page).getByRole('heading', { name: `Merged change ${number}` }),
    ).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(
      page.locator('#issue-rows .row').first().locator('button.title'),
    ).toBeFocused();
  });
}

for (const [group, number] of [
  ['Closes', 11],
  ['Refs', 12],
  ['Mentions', 13],
] as const) {
  test(`a ${group} pill to a pull request off the board opens its pop-up`, async ({
    page,
  }) => {
    await open(page);
    await pill(page, group, number).click();

    await expect(prDialog(page)).toBeVisible();
    await expect(
      prDialog(page).getByRole('heading', { name: `Merged change ${number}` }),
    ).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(1);
  });
}

for (const width of [1280, 390]) {
  test(`the pop-up of a merged pull request shows its Related band at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    await pill(page, 'Mentioned by', 7).click();
    const dialog = prDialog(page);
    await expect(dialog).toContainText('read from the forge');

    const rows = dialog.locator('.related-band [role="group"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAccessibleName('Closes');
    await expect(rows.nth(1)).toHaveAccessibleName('Refs');
    await expect(rows.nth(2)).toHaveAccessibleName('Mentions');
    await expect(
      dialog.getByRole('group', { name: 'Closes' }).locator('.linked-pr'),
    ).toHaveAccessibleName(/^Closes: Issue #20/);

    // A pill in it is navigable: the issue's pop-up replaces this one.
    await dialog
      .getByRole('group', { name: 'Closes' })
      .locator('.linked-pr')
      .click();
    await expect(issueDialog(page)).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(
      page.locator('#issue-rows .row').first().locator('button.title'),
    ).toBeFocused();
  });
}

async function expectAxeClean(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, scheme).toEqual([]);
  }
}

// A pill in the Related band of a merged pull request's own pop-up names
// another pull request the board doesn't list. It reaches the same retarget
// through the pop-up's callers, not the issue's.
for (const [group, number] of [
  ['Mentions', 31],
  ['Refs', 8],
] as const) {
  test(`a ${group} pill in a merged pull request's pop-up opens pull request ${number}`, async ({
    page,
  }) => {
    await open(page);
    await pill(page, 'Mentioned by', 7).click();
    await expect(prDialog(page)).toContainText('read from the forge');

    await prDialog(page)
      .getByRole('group', { name: group })
      .locator('.linked-pr', { hasText: `#${number}` })
      .click();

    await expect(
      prDialog(page).getByRole('heading', { name: `Merged change ${number}` }),
    ).toBeVisible();
    await expect(prDialog(page)).toContainText(
      `Pull request ${number}, read from the forge`,
    );
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expectAxeClean(page);

    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(originRow(page)).toBeFocused();
  });
}

// A reference to a merged pull request in a repository the dashboard doesn't
// track is a forge link until the forge has answered for it (#4269). Once it
// has, a click opens the pull request's pop-up rather than a new tab.
test('a reference to a merged pull request in an untracked repository opens its pop-up', async ({
  page,
}) => {
  await open(page);
  const reference = issueDialog(page).locator(
    `a[data-ref-repo="${FOREIGN}"][data-ref-number="50"]`,
  );
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/issues/details') &&
      response.url().includes('number=50'),
  );
  await reference.hover();
  await answered;
  const opened = page
    .waitForEvent('popup', { timeout: 1000 })
    .then(() => true)
    .catch(() => false);

  await reference.click();

  await expect(
    prDialog(page).getByRole('heading', { name: 'Merged change 50' }),
  ).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  expect(await opened).toBe(false);
  await expectAxeClean(page);

  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(originRow(page)).toBeFocused();
});

test('a pull request that cannot be read leaves a pop-up that says why', async ({
  page,
}) => {
  await open(page, true);
  await pill(page, 'Mentioned by', 7).click();

  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.locator('dialog[open]')).toContainText(
    'the forge could not be reached',
  );
});

test('a pill to a pull request on the board still opens it in place', async ({
  page,
}) => {
  await open(page);
  await pill(page, 'Mentioned by', 9).click();

  await expect(prDialog(page)).toBeVisible();
  await expect(prDialog(page)).toContainText('Pull request 9');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the pop-up opened from a merged pill has no axe violations in ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    await pill(page, 'Mentioned by', 7).click();
    await expect(prDialog(page)).toBeVisible();
    await expect(prDialog(page)).toContainText('read from the forge');
    await expect(prDialog(page).locator('.related-band')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

// Coverage for #4346. The behaviour shipped in #4477 and #4492, so these pass
// on a first run: they pin what the acceptance criteria ask for.
const dialogBand = (page: Page) => prDialog(page).locator('.related-band');

test('a pull request off the board with nothing outgoing has no Related band', async ({
  page,
}) => {
  await open(page);
  await pill(page, 'Mentioned by', 40).click();
  await expect(prDialog(page)).toContainText('read from the forge');
  await expect(dialogBand(page)).toHaveCount(0);
});

test('the band of a pull request off the board folds pills past the cap', async ({
  page,
}) => {
  await open(page);
  await pill(page, 'Mentioned by', 41).click();
  await expect(prDialog(page)).toContainText('read from the forge');
  const row = prDialog(page).getByRole('group', { name: 'Mentions' });
  await expect(row.locator('.linked-pr')).toHaveCount(6);
  const toggle = row.locator('.related-toggle');
  await expect(toggle).toHaveText('+2 more');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(row.locator('.linked-pr')).toHaveCount(8);
});

test('an open pull request in an untracked repository gets the same band', async ({
  page,
}) => {
  await open(page);
  const reference = issueDialog(page).locator(
    `a[data-ref-repo="${FOREIGN}"][data-ref-number="51"]`,
  );
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/issues/details') &&
      response.url().includes('number=51'),
  );
  await reference.hover();
  await answered;
  await reference.click();

  await expect(
    prDialog(page).getByRole('heading', { name: 'Merged change 51' }),
  ).toBeVisible();
  await expect(dialogBand(page)).toBeVisible();
  await expect(
    prDialog(page).getByRole('group', { name: 'Mentions' }),
  ).toBeVisible();
});

test('the pop-up of a pull request off the board has no axe violations at 390px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page);
  await pill(page, 'Mentioned by', 7).click();
  await expect(prDialog(page)).toContainText('read from the forge');
  await expect(dialogBand(page)).toBeVisible();
  await expectAxeClean(page);
});
