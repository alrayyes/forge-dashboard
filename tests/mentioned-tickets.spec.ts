import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// A pull request's dialog lists the tickets it mentions without closing, and
// a ticket's dialog lists the pull requests that mention it. The server reads
// the text, so these mock /api/v1/dashboard with the fields it returns and only
// check what the page draws. Writes no saved state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REPO = 'alrayyes/forge-dashboard';

const mention = (number: number, over: Record<string, unknown> = {}) => ({
  repo: REPO,
  number,
  url: `https://example.com/${REPO}/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${REPO}/${number}`,
  tracked: true,
  ...over,
});

const none = { passed: 0, running: 0, waiting: 0, failed: 0 };
const mentioning = (number: number) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'success',
  checks: { ...none, passed: 3 },
  awaitingWorkflowApproval: false,
});

const pullRequest = (number: number, mentionsIssues: unknown[]) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Pull request ${number}`,
  url: `https://example.com/pull/${number}`,
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
  mentionsIssues,
});

const issue = (number: number, mentionedByPullRequests: unknown[]) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Issue ${number}`,
  url: `https://example.com/issues/${number}`,
  author: 'ryankes',
  labels: [{ name: 'enhancement' }],
  createdAt: ago(60),
  updatedAt: ago(5),
  linkedPullRequests: [],
  mentionedByPullRequests,
});

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const details = {
  description: {
    text: 'The text.',
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
  board: { pullRequests?: unknown[]; issues?: unknown[] },
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
        body: JSON.stringify(details),
      }),
    );
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const openPullRequest = (page: Page) =>
  page
    .getByRole('button', { name: /Pull request 1/ })
    .first()
    .click();
const openIssue = (page: Page) =>
  page.locator('#issue-rows .row').first().locator('button.title').click();

test.describe('the pull request dialog', () => {
  test('lists a tracked ticket as a pill that opens it', async ({ page }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [mention(20)])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);

    const pill = prDialog(page).locator('.mention-pill');
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveText('#20');
    await expect(pill).toHaveAccessibleName('Mentions: #20, opens the issue');
    await expect(pill).toHaveAttribute('href', mention(20).pageUrl);
  });

  test('links a ticket the dashboard does not track straight to the forge', async ({
    page,
  }) => {
    const other = mention(4, {
      repo: 'alrayyes/other',
      url: 'https://example.com/alrayyes/other/issues/4',
      tracked: false,
    });
    await mockBoard(page, { pullRequests: [pullRequest(1, [other])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);

    const pill = prDialog(page).locator('.mention-pill');
    await expect(pill).toHaveText('alrayyes/other#4');
    await expect(pill).toHaveAccessibleName(
      'Mentions: alrayyes/other#4, opens on the forge',
    );
    await expect(pill).toHaveAttribute('href', other.url);
    await expect(pill).toHaveAttribute('target', '_blank');
    await expect(pill).toHaveAttribute('rel', /noopener/);
  });

  // #4321: an untracked item the forge can show opens in the dialog, like the
  // same item written in the description (#4269). The forge is asked while the
  // pointer or focus rests on the pill; a click before that answer follows the
  // link.
  const untracked = () =>
    mention(4, {
      repo: 'alrayyes/other',
      url: 'https://example.com/alrayyes/other/issues/4',
      tracked: false,
    });
  const untrackedPill = (page: Page) => prDialog(page).locator('.mention-pill');

  // A pill opens the dialog only once the page has read the answer's body,
  // which is later than the response arriving, so note it from inside the
  // page (#5062). The timeout runs after the reader of that body has.
  async function noteIssueRead(page: Page) {
    await page.evaluate(() => {
      const json = Response.prototype.json;
      Response.prototype.json = function () {
        const read = json.call(this);
        if (this.url.includes('/api/v1/issues/details'))
          read.then(() =>
            setTimeout(() => {
              document.documentElement.dataset.issueRead = 'true';
            }),
          );
        return read;
      };
    });
  }
  const issueRead = (page: Page) =>
    expect(page.locator('html[data-issue-read]')).toBeAttached();

  async function answerIssues(page: Page, status: number) {
    await noteIssueRead(page);
    await page.route('**/api/v1/issues/details*', (route: Route) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(
          status === 200
            ? {
                ...details,
                description: { ...details.description, text: 'Merged text.' },
                state: 'closed',
              }
            : { error: 'not found' },
        ),
      }),
    );
  }

  test('a plain click on an untracked pill opens it read-only in the dialog and focus comes back', async ({
    page,
  }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [untracked()])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);
    await answerIssues(page, 200);
    const pill = untrackedPill(page);
    await pill.hover();
    await issueRead(page);
    const before = page.url();
    // The link is target=_blank, so a click that also followed it would open a
    // tab as well as the dialog. Listen before the click, and look after.
    const opened = page
      .waitForEvent('popup', { timeout: 1000 })
      .then(() => true)
      .catch(() => false);

    await pill.click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toContainText('Merged text.');
    await expect(prDialog(page)).toBeHidden();
    await expect(
      issueDialog(page).getByRole('button', { name: /^Close issue/ }),
    ).toHaveCount(0);
    expect(await opened).toBe(false);
    expect(page.context().pages()).toHaveLength(1);
    expect(page.url()).toBe(before);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations, scheme).toEqual([]);
    }

    await page.keyboard.press('Escape');
    await expect(issueDialog(page)).toBeHidden();
    await expect(
      page.getByRole('button', { name: /Pull request 1/ }).first(),
    ).toBeFocused();
  });

  test('closing the dialog an untracked pill opened returns focus to the pull request title, not to what opened the first dialog', async ({
    page,
  }) => {
    // The first dialog opens from the row's comments pill. The browser would
    // hand focus back to that pill, so only the page naming the title as the
    // trigger puts focus on the title.
    await mockBoard(page, {
      pullRequests: [{ ...pullRequest(1, [untracked()]), reviewComments: 2 }],
    });
    await page.goto('/pull-requests.html');
    await page.locator('.review-pill').first().click();
    await expect(prDialog(page)).toBeVisible();
    await answerIssues(page, 200);
    const pill = untrackedPill(page);
    await pill.hover();
    await issueRead(page);

    await pill.click();
    await expect(issueDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(issueDialog(page)).toBeHidden();
    await expect(
      page.getByRole('button', { name: /Pull request 1/ }).first(),
    ).toBeFocused();
  });

  test('a tracked pill asks the forge about nothing', async ({ page }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [mention(20)])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);
    let asked = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/issues/details')) asked++;
    });
    const pill = prDialog(page).locator('.mention-pill');

    await pill.hover();
    await pill.focus();
    await pill.dispatchEvent('pointerdown');
    await page.waitForTimeout(500);

    expect(asked).toBe(0);
  });

  test('focus on an untracked pill asks the forge, so Enter opens the dialog', async ({
    page,
  }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [untracked()])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);
    await answerIssues(page, 200);
    await untrackedPill(page).focus();
    await issueRead(page);

    await page.keyboard.press('Enter');

    await expect(issueDialog(page)).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);
  });

  test('sweeping the pointer over an untracked pill asks the forge only once it rests', async ({
    page,
  }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [untracked()])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);
    let asked = 0;
    await page.route('**/api/v1/issues/details*', (route: Route) => {
      asked++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...details, state: 'closed' }),
      });
    });
    const pill = untrackedPill(page);

    const box = (await pill.boundingBox()) as { x: number; y: number };
    await page.mouse.move(box.x + 2, box.y + 2);
    await page.mouse.move(box.x + 2, box.y - 400);
    await page.waitForTimeout(400);
    expect(asked).toBe(0);

    await pill.hover();
    await expect.poll(() => asked).toBe(1);
  });

  test('pressing an untracked pill asks the forge at once', async ({
    page,
  }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [untracked()])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);
    let asked = 0;
    await page.route('**/api/v1/issues/details*', (route: Route) => {
      asked++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...details, state: 'closed' }),
      });
    });

    await untrackedPill(page).dispatchEvent('pointerdown');

    await expect.poll(() => asked).toBe(1);
  });

  test('an untracked pill the forge cannot show still goes to the forge in a new tab', async ({
    page,
  }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [untracked()])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);
    await answerIssues(page, 404);
    const pill = untrackedPill(page);
    const answered = page.waitForResponse('**/api/v1/issues/details*');
    await pill.hover();
    await answered;
    await expect(pill).toHaveAccessibleName(
      'Mentions: alrayyes/other#4, opens on the forge',
    );
    const popup = page.context().waitForEvent('page');

    await pill.click();

    const tab = await popup;
    await tab.waitForURL(untracked().url, { waitUntil: 'commit' });
    await tab.close();
    await expect(prDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toBeHidden();
  });

  test('a click on an untracked pill before the forge has answered follows the link', async ({
    page,
  }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [untracked()])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);
    // Hold the forge's answer until the click has been handled.
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let asked = 0;
    await page.route('**/api/v1/issues/details*', async (route: Route) => {
      asked++;
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...details, state: 'closed' }),
      });
    });
    const popup = page.context().waitForEvent('page');

    await untrackedPill(page).click();

    const tab = await popup;
    await tab.waitForURL(untracked().url, { waitUntil: 'commit' });
    await tab.close();
    await expect(prDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toBeHidden();
    expect(asked).toBe(1);
    answer();
  });

  test('a modified click on an untracked pill is left to the browser', async ({
    page,
  }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [untracked()])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);
    await answerIssues(page, 200);
    const pill = untrackedPill(page);
    await pill.hover();
    await issueRead(page);
    const popup = page.context().waitForEvent('page');

    await pill.click({ modifiers: ['ControlOrMeta'] });

    await (await popup).close();
    await expect(prDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toBeHidden();
  });

  test('folds mentions past the sixth behind one toggle that opens them and folds them again', async ({
    page,
  }) => {
    await mockBoard(page, {
      pullRequests: [
        pullRequest(
          1,
          [20, 21, 22, 23, 24, 25, 26, 27].map((n) => mention(n)),
        ),
      ],
    });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);

    const pills = prDialog(page).locator('.mention-pill');
    await expect(pills).toHaveCount(6);
    const toggle = prDialog(page).locator('.related-toggle');
    await expect(toggle).toHaveText('+2 more');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAccessibleName(
      '+2 more, 2 more issues that this pull request mentions',
    );
    await toggle.click();
    await expect(pills).toHaveCount(8);
    await expect(pills.nth(6)).toBeFocused();
    await expect(toggle).toHaveText('Show fewer');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(pills).toHaveCount(6);
    await expect(toggle).toHaveText('+2 more');
    await expect(toggle).toBeFocused();
  });

  test('shows nothing when no ticket is mentioned', async ({ page }) => {
    await mockBoard(page, { pullRequests: [pullRequest(1, [])] });
    await page.goto('/pull-requests.html');
    await openPullRequest(page);

    await expect(prDialog(page)).toBeVisible();
    await expect(prDialog(page).locator('.mention-pill')).toHaveCount(0);
    await expect(prDialog(page).locator('.related-band')).toHaveCount(0);
  });
});

test.describe('the issue dialog', () => {
  test('lists a pull request that mentions the issue, under a label', async ({
    page,
  }) => {
    await mockBoard(page, { issues: [issue(1, [mentioning(7)])] });
    await page.goto('/issues.html');
    await openIssue(page);

    const pill = issueDialog(page).locator('.mention-pill');
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveAccessibleName(/^Mentioned by: PR #7 · Open/);
    await expect(pill).toHaveAttribute('href', mentioning(7).pageUrl);
    await expect(issueDialog(page).getByText('Mentioned by')).toBeVisible();
  });

  test('has no label or pill when no pull request mentions it', async ({
    page,
  }) => {
    await mockBoard(page, { issues: [issue(1, [])] });
    await page.goto('/issues.html');
    await openIssue(page);

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page).locator('.mention-pill')).toHaveCount(0);
    await expect(issueDialog(page).locator('.related-band')).toHaveCount(0);
  });
});

test('both dialogs have no accessibility violations in light, dark and at 390 px', async ({
  page,
}) => {
  await mockBoard(page, {
    pullRequests: [
      pullRequest(1, [
        mention(20),
        mention(4, { repo: 'alrayyes/other', tracked: false }),
      ]),
    ],
    issues: [issue(1, [mentioning(7), mentioning(8)])],
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [path, open, dialog] of [
        ['/pull-requests.html', openPullRequest, prDialog],
        ['/issues.html', openIssue, issueDialog],
      ] as const) {
        await page.goto(path);
        await open(page);
        await expect(
          dialog(page).locator('.mention-pill').first(),
        ).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, `${path} ${scheme} at ${width}px`).toEqual(
          [],
        );
      }
    }
  }
});
