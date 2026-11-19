import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The Related band at the top of the pull request and issue dialogs (#4220):
// the pills of what the item closes, references and mentions (or is closed,
// referenced and mentioned by), above the description. Mocks
// /api/v1/dashboard and the details endpoints only and writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';
const OTHER = 'alrayyes/other';

const ticket = (number: number, over: Record<string, unknown> = {}) => ({
  repo: REPO,
  number,
  url: `https://example.com/${REPO}/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${REPO}/${number}`,
  tracked: true,
  ...over,
});
const refs = (number: number, over: Record<string, unknown> = {}) =>
  ticket(number, { relation: 'refs', ...over });

const none = { passed: 0, running: 0, waiting: 0, failed: 0 };
const linked = (number: number, over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'none',
  checks: none,
  awaitingWorkflowApproval: false,
  ...over,
});

const pullRequest = (over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number: 1,
  title: 'Pull request 1',
  url: 'https://example.com/pull/1',
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
  ...over,
});

const issue = (over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number: 1,
  title: 'Issue 1',
  url: 'https://example.com/issues/1',
  author: 'ryankes',
  labels: [{ name: 'enhancement' }],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests: [],
  ...over,
});

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'The description.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
  state: 'open',
};

async function mockBoard(
  page: Page,
  board: {
    pullRequests?: unknown[];
    issues?: unknown[];
    // What the issue's details list as its references.
    references?: unknown[];
  },
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: board.pullRequests ?? [],
        issues: board.issues ?? [],
      }),
    }),
  );
  for (const endpoint of ['pull-requests', 'issues'])
    await page.route(`**/api/v1/${endpoint}/details*`, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          endpoint === 'issues'
            ? { ...details, references: board.references ?? [] }
            : details,
        ),
      }),
    );
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const band = (dialog: Locator) => dialog.locator('.related-band');
const row = (dialog: Locator, label: string) =>
  dialog.getByRole('group', { name: label });

async function openPullRequest(page: Page, pr = pullRequest()) {
  await mockBoard(page, { pullRequests: [pr] });
  await page.goto('/pull-requests.html');
  await page
    .getByRole('button', { name: /Pull request 1/ })
    .first()
    .click();
  await expect(prDialog(page)).toBeVisible();
  return prDialog(page);
}

async function openIssue(
  page: Page,
  item = issue(),
  references: unknown[] = [],
) {
  await mockBoard(page, { issues: [item], references });
  await page.goto('/issues.html');
  await page
    .locator('#issue-rows .row')
    .first()
    .locator('button.title')
    .click();
  await expect(issueDialog(page)).toBeVisible();
  return issueDialog(page);
}

const fullPullRequest = () =>
  pullRequest({
    closesIssues: [ticket(138), ticket(131)],
    refsIssues: [refs(7, { repo: OTHER })],
    mentionsIssues: [],
  });

test('a pull request dialog has a Related band between the title and the description', async ({
  page,
}) => {
  const dialog = await openPullRequest(page, fullPullRequest());

  await expect(band(dialog)).toBeVisible();
  await expect(row(dialog, 'Closes').locator('.linked-pr')).toHaveCount(2);
  const refsRow = row(dialog, 'Refs').locator('.linked-pr');
  await expect(refsRow).toHaveCount(1);
  await expect(refsRow).toHaveText('alrayyes/other#7');
  expect(await refsRow.evaluate((el) => getComputedStyle(el).borderStyle)).toBe(
    'dotted',
  );
  await expect(row(dialog, 'Mentions')).toHaveCount(0);
  // The count is the distinct items, not the rows.
  await expect(dialog.locator('.related-count')).toHaveText('3');

  const [header, related, body] = await Promise.all(
    ['.details-header', '.related-band', '.details-body'].map((selector) =>
      dialog.locator(selector).boundingBox(),
    ),
  );
  expect(related?.y).toBeGreaterThanOrEqual(
    (header?.y ?? 0) + (header?.height ?? 0) - 1,
  );
  expect(body?.y).toBeGreaterThanOrEqual(
    (related?.y ?? 0) + (related?.height ?? 0) - 1,
  );
  // Moved, not duplicated: the old header cluster no longer holds the pills.
  await expect(dialog.locator('.details-attributes .linked-pr')).toHaveCount(0);
});

test('every pill name leads with the relation and contains the visible text', async ({
  page,
}) => {
  const dialog = await openPullRequest(
    page,
    pullRequest({
      closesIssues: [ticket(138)],
      refsIssues: [refs(7, { repo: OTHER })],
      mentionsIssues: [ticket(9)],
    }),
  );
  await expect(
    row(dialog, 'Closes').locator('.linked-pr'),
  ).toHaveAccessibleName('Closes: #138, opens the issue');
  await expect(row(dialog, 'Refs').locator('.linked-pr')).toHaveAccessibleName(
    'Refs: alrayyes/other#7, does not close, opens the issue',
  );
  await expect(
    row(dialog, 'Mentions').locator('.linked-pr'),
  ).toHaveAccessibleName('Mentions: #9, opens the issue');
});

test('an issue dialog pins the closing pull request name: relation, number, draft word and pipeline', async ({
  page,
}) => {
  const dialog = await openIssue(
    page,
    issue({
      linkedPullRequests: [
        linked(142, {
          draft: true,
          ci: 'pending',
          checks: { passed: 3, running: 2, waiting: 0, failed: 1 },
        }),
      ],
      mentionedByPullRequests: [20, 21, 22, 23, 24].map((n) => linked(n)),
    }),
  );

  const closedBy = row(dialog, 'Closed by').locator('.linked-pr');
  await expect(closedBy).toHaveCount(1);
  await expect(closedBy).toHaveAccessibleName(
    'Closed by: PR #142 · Draft Running 3 2 1: 3 passed, 2 running, 1 failed',
  );
  await expect(closedBy).toContainText('PR #142 · Draft');
  await expect(closedBy.locator('.ci-pill').first()).toBeVisible();
  // Five mentions sit under the fold of six, so no toggle.
  await expect(row(dialog, 'Mentioned by').locator('.linked-pr')).toHaveCount(
    5,
  );
  await expect(dialog.locator('.related-toggle')).toHaveCount(0);
  await expect(dialog.locator('.related-count')).toHaveText('6');
});

test('an issue also referenced by pull requests has a Referenced by row with the hint', async ({
  page,
}) => {
  const dialog = await openIssue(
    page,
    issue({
      linkedPullRequests: [linked(12)],
      referencedByPullRequests: [linked(13)],
    }),
  );
  await expect(dialog.locator('.related-label')).toHaveText([
    'Closed by',
    'Referenced by',
  ]);
  await expect(
    row(dialog, 'Referenced by').locator('.related-hint'),
  ).toHaveText('Italic: these reference the issue, they do not close it.');
});

test('an issue referenced by a pull request pins the pill name: Referenced by, then the pull request', async ({
  page,
}) => {
  const dialog = await openIssue(
    page,
    issue({ referencedByPullRequests: [linked(13)] }),
  );
  await expect(
    row(dialog, 'Referenced by').locator('.linked-pr'),
  ).toHaveAccessibleName('Referenced by: PR #13 · Open');
});

test('a row of more than six shows six, and the keyboard opens and folds the rest', async ({
  page,
}) => {
  const dialog = await openPullRequest(
    page,
    pullRequest({
      closesIssues: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ticket(100 + n)),
    }),
  );
  const pills = row(dialog, 'Closes').locator('.linked-pr');
  const toggle = dialog.locator('.related-toggle');
  await expect(pills).toHaveCount(6);
  await expect(toggle).toHaveText('+2 more');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(pills).toHaveCount(8);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveText('Show fewer');
  await expect(toggle).toHaveAccessibleName(/^Show fewer/);

  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(pills).toHaveCount(6);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('a plain click on a closing pill swaps the dialog for the issue, with its title and filer', async ({
  page,
}) => {
  await mockBoard(page, {
    pullRequests: [pullRequest({ closesIssues: [ticket(138)] })],
    issues: [issue({ number: 138, title: 'The listed issue' })],
  });
  await page.goto('/pull-requests.html');
  await page
    .getByRole('button', { name: /Pull request 1/ })
    .first()
    .click();
  await row(prDialog(page), 'Closes').locator('.linked-pr').click();

  await expect(issueDialog(page)).toBeVisible();
  await expect(issueDialog(page)).toContainText('The listed issue');
  await expect(issueDialog(page)).toContainText('ryankes');
});

// A closed issue is not on the board, so no snapshot row carries what refers
// to it (#4271): the dialog reads it from the issue's own details.
const reference = (number: number, over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Item ${number}`,
  url: `https://example.com/${REPO}/issues/${number}`,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  kind: 'pullRequest',
  state: 'merged',
  direction: 'incoming',
  relation: 'closes',
  ...over,
});

async function openClosedIssue(page: Page, references: unknown[]) {
  await mockBoard(page, {
    pullRequests: [pullRequest({ closesIssues: [ticket(4055)] })],
    issues: [],
  });
  await page.route('**/api/v1/issues/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...details, state: 'closed', references }),
    }),
  );
  await page.goto('/pull-requests.html');
  await page
    .getByRole('button', { name: /Pull request 1/ })
    .first()
    .click();
  await row(prDialog(page), 'Closes').locator('.linked-pr').click();
  await expect(issueDialog(page)).toBeVisible();
  return issueDialog(page);
}

test('a closed issue that is off the board shows what refers to it, with each state', async ({
  page,
}) => {
  const dialog = await openClosedIssue(page, [
    reference(4100),
    reference(4150, {
      kind: 'issue',
      state: 'closed',
      relation: 'mentions',
      pageUrl: `/issues.html?issue=github/${REPO}/4150`,
    }),
    reference(4200, { direction: 'outgoing', relation: 'refs' }),
  ]);

  await expect(dialog.locator('.related-label')).toHaveText([
    'Closed by',
    'Mentioned by',
    'Refs',
  ]);
  await expect(
    row(dialog, 'Closed by').locator('.linked-pr'),
  ).toHaveAccessibleName('Closed by: PR #4100 · Merged');
  await expect(row(dialog, 'Closed by').locator('.linked-pr')).toHaveText(
    'PR #4100 · Merged',
  );
  await expect(
    row(dialog, 'Mentioned by').locator('.linked-pr'),
  ).toHaveAccessibleName('Mentioned by: Issue #4150 closed');
  // What the issue itself refers to follows, in rows of its own (#4272).
  await expect(row(dialog, 'Refs').locator('.linked-pr')).toHaveAccessibleName(
    'Refs: PR #4200 · Merged',
  );
  await expect(dialog.locator('.related-count')).toHaveText('3');
});

const outgoing = (number: number, over: Record<string, unknown> = {}) =>
  reference(number, { direction: 'outgoing', relation: 'refs', ...over });

test('an issue on the board lists what it refers to, after what refers to it', async ({
  page,
}) => {
  const dialog = await openIssue(
    page,
    issue({ linkedPullRequests: [linked(142)] }),
    [
      outgoing(4297, { kind: 'issue', state: 'open' }),
      outgoing(4300, { relation: 'mentions', kind: 'issue', state: 'closed' }),
    ],
  );

  await expect(dialog.locator('.related-label')).toHaveText([
    'Closed by',
    'Refs',
    'Mentions',
  ]);
  const refsPill = row(dialog, 'Refs').locator('.linked-pr');
  await expect(refsPill).toHaveAccessibleName('Refs: Issue #4297');
  await expect(refsPill).toHaveAttribute(
    'title',
    'This issue references this, it does not close it',
  );
  await expect(
    row(dialog, 'Mentions').locator('.linked-pr'),
  ).toHaveAccessibleName('Mentions: Issue #4300 closed');
  await expect(row(dialog, 'Refs')).toContainText(
    'Italic: this issue references these, it does not close them.',
  );
  await expect(dialog.locator('.related-count')).toHaveText('3');
});

test('a pill for what the issue refers to is a link to the item', async ({
  page,
}) => {
  const dialog = await openIssue(page, issue(), [outgoing(4297)]);

  await expect(row(dialog, 'Refs').locator('a.linked-pr')).toHaveAttribute(
    'href',
    `/pull-requests.html?pr=github/${REPO}/4297`,
  );
});

test('the rows for what an issue refers to have no axe violations', async ({
  page,
}) => {
  await openIssue(page, issue({ linkedPullRequests: [linked(142)] }), [
    outgoing(4297),
    outgoing(4300, { relation: 'mentions' }),
  ]);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page })
      .include('.related-band')
      .analyze();
    expect(results.violations, scheme).toEqual([]);
  }
});

test('an issue that refers to nothing has no outgoing rows', async ({
  page,
}) => {
  const dialog = await openIssue(
    page,
    issue({ linkedPullRequests: [linked(142)] }),
  );

  await expect(dialog.locator('.related-label')).toHaveText(['Closed by']);
});

test('an open pull request pill under Closed by says its state', async ({
  page,
}) => {
  const dialog = await openIssue(
    page,
    issue({ linkedPullRequests: [linked(142)] }),
  );
  const pill = row(dialog, 'Closed by').locator('.linked-pr');
  await expect(pill).toHaveText('PR #142 · Open');
  await expect(pill).toHaveAccessibleName('Closed by: PR #142 · Open');
});

// The target of a pill is the pill plus the hit area its ::after adds. The
// sizes are logged so the pull request can state what was measured.
const targetSize = (pill: Locator) =>
  pill.evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    const box = el.getBoundingClientRect();
    return {
      height: Math.max(box.height, Number.parseFloat(after.height) || 0),
      width: Math.max(box.width, Number.parseFloat(after.width) || 0),
    };
  });

for (const [name, viewport, floor] of [
  ['desktop', { width: 1280, height: 800 }, 24],
  ['phone', { width: 390, height: 800 }, 44],
] as const) {
  test(`every state of a pull request pill is a ${floor}px target on ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const board = await openIssue(
      page,
      issue({
        linkedPullRequests: [linked(142), linked(143, { draft: true })],
      }),
    );
    const sizes: Record<string, unknown> = {};
    const pills = row(board, 'Closed by').locator('.linked-pr');
    for (const [i, state] of ['Open', 'Draft'].entries()) {
      await expect(pills.nth(i)).toContainText(`· ${state}`);
      sizes[state] = await targetSize(pills.nth(i));
    }
    await page.keyboard.press('Escape');

    const closed = await openClosedIssue(page, [
      reference(4100),
      reference(4101, { state: 'closed' }),
    ]);
    const states = row(closed, 'Closed by').locator('.linked-pr');
    for (const [i, state] of ['Merged', 'Closed'].entries()) {
      await expect(states.nth(i)).toContainText(`· ${state}`);
      sizes[state] = await targetSize(states.nth(i));
    }
    console.log(`SIZES ${name} ${JSON.stringify(sizes)}`);
    for (const size of Object.values(sizes) as { height: number }[])
      expect(size.height).toBeGreaterThanOrEqual(floor);
  });
}

test('a closed issue that nothing refers to has no band and no error', async ({
  page,
}) => {
  const dialog = await openClosedIssue(page, []);

  await expect(band(dialog)).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('a dialog with nothing related has no band and no empty row', async ({
  page,
}) => {
  const dialog = await openPullRequest(page);
  await expect(band(dialog)).toHaveCount(0);
  await expect(dialog.locator('.related-row')).toHaveCount(0);
});

test('the label and count meet 4.5:1 on the band, and a focused pill ring is not cropped', async ({
  page,
}) => {
  const dialog = await openPullRequest(page, fullPullRequest());
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page })
      .include('.related-band')
      .withRules(['color-contrast'])
      .analyze();
    expect(results.violations, scheme).toEqual([]);

    const first = row(dialog, 'Closes').locator('.linked-pr').first();
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    const [pill, box] = await Promise.all([
      first.boundingBox(),
      band(dialog).boundingBox(),
    ]);
    // 2px ring at a 1px offset.
    const ring = 3;
    expect(pill?.x ?? 0).toBeGreaterThanOrEqual((box?.x ?? 0) + ring);
    expect((pill?.x ?? 0) + (pill?.width ?? 0)).toBeLessThanOrEqual(
      (box?.x ?? 0) + (box?.width ?? 0) - ring,
    );
    expect(pill?.y ?? 0).toBeGreaterThanOrEqual((box?.y ?? 0) + ring);
    expect((pill?.y ?? 0) + (pill?.height ?? 0)).toBeLessThanOrEqual(
      (box?.y ?? 0) + (box?.height ?? 0) - ring,
    );
    expect(
      await band(dialog).evaluate((el) => getComputedStyle(el).overflow),
    ).toBe('visible');
  }
});

const everything = {
  pullRequest: () =>
    pullRequest({
      closesIssues: [ticket(138), ticket(131)],
      refsIssues: [
        refs(7, {
          repo: 'alrayyes/a-very-long-repository-name-for-a-wrapped-pill',
        }),
      ],
      mentionsIssues: [ticket(9), ticket(10, { tracked: false })],
    }),
  issue: () =>
    issue({
      linkedPullRequests: [
        linked(142, {
          draft: true,
          ci: 'pending',
          checks: { passed: 3, running: 2, waiting: 0, failed: 1 },
        }),
      ],
      referencedByPullRequests: [linked(13)],
      mentionedByPullRequests: [20, 21, 22, 23, 24, 25, 26, 27].map((n) =>
        linked(n),
      ),
    }),
};

for (const width of [1280, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`both dialogs have no axe violations, no sideways scroll and pills of 24px or more at ${width}px, ${scheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await mockBoard(page, {
        pullRequests: [everything.pullRequest()],
        issues: [everything.issue()],
      });
      for (const [path, dialogOf] of [
        ['/pull-requests.html', prDialog],
        ['/issues.html', issueDialog],
      ] as const) {
        await page.goto(path);
        await page.locator('button.title').first().click();
        const dialog = dialogOf(page);
        await expect(band(dialog)).toBeVisible();
        const toggle = dialog.locator('.related-toggle');
        if (await toggle.count()) await toggle.click();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations, `${path}`).toEqual([]);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        ).toBe(true);
        for (const pill of await band(dialog).locator('.linked-pr').all())
          expect(
            (await pill.boundingBox())?.height ?? 0,
            await pill.innerText(),
          ).toBeGreaterThanOrEqual(24);

        const shots = process.env.RELATED_BAND_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/${path.includes('issues') ? 'issue' : 'pull-request'}-${width}-${scheme}.png`,
          });
      }
    });
  }
}
