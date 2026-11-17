import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #4188: a #N that is a pull request opened an error ("Could not resolve to an
// Issue"), because every unlisted reference was looked up as an issue. The
// issues endpoint now says which kind the number is, and the dialog follows it,
// wherever the reference sits: in a pull request, an issue or a comment.
// https://github.com/alrayyes/forge-dashboard/issues/4188

const REPO = 'alrayyes/forge-dashboard';
const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const body = (text: string) => ({
  text,
  format: 'markdown',
  truncated: false,
  edited: false,
  reactions: noReactions,
});
const comment = (text: string) => ({
  id: '1',
  author: null,
  createdAt: new Date().toISOString(),
  updatedAt: null,
  ...body(text),
});
const thread = (text: string, comments: string[] = []) => ({
  description: body(text),
  comments: comments.map(comment),
  commentCount: comments.length,
  commentsTruncated: false,
});

const now = new Date().toISOString();
const pullRequest = {
  forge: 'github',
  repo: REPO,
  number: 42,
  title: 'Add structured logging',
  url: `https://github.com/${REPO}/pull/42`,
  author: 'claude',
  draft: false,
  ci: 'success',
  labels: [],
  createdAt: now,
  updatedAt: now,
  mergeStatus: 'mergeable',
  allowedActions: [{ action: 'merge' }],
};
const issue = {
  forge: 'github',
  repo: REPO,
  number: 12,
  title: 'Logging is noisy',
  url: `https://github.com/${REPO}/issues/12`,
  author: 'claude',
  labels: [],
  createdAt: now,
  updatedAt: now,
};

// 4177 is a pull request the board doesn't list, 4100 an issue it doesn't
// list, 9999 neither.
async function open(
  page: Page,
  from: 'pull-requests' | 'issues',
  text: string,
  comments: string[] = [],
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: now,
        forges: [
          {
            forge: 'github',
            reachable: true,
            repoCount: 1,
            capabilities: { label: 'GitHub' },
          },
        ],
        pullRequests: [pullRequest],
        issues: [issue],
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...thread(text, comments), releaseNotes: null }),
    }),
  );
  await page.route('**/api/v1/issues/details*', (route: Route) => {
    const number = new URL(route.request().url()).searchParams.get('number');
    if (number === '4177')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...thread('The linked change.'),
          kind: 'pullRequest',
          state: 'open',
        }),
      });
    if (number === '9999')
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github: issue or pull request not found: #9999 in x/y',
        }),
      });

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...thread(number === '12' ? text : 'An older issue.', comments),
        kind: 'issue',
        state: 'open',
      }),
    });
  });
  await page.goto(`/${from}.html`);
  await page
    .getByRole('button', {
      name: from === 'issues' ? /^#12 / : /^#42 /,
    })
    .click();
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });

test.describe('a reference to a pull request opens it (#4188)', () => {
  test('from a pull request body', async ({ page }) => {
    await open(page, 'pull-requests', 'Refs #4177');
    await prDialog(page).getByRole('link', { name: '#4177' }).click();

    await expect(prDialog(page)).toContainText('The linked change.');
    await expect(prDialog(page)).toContainText('#4177');
    await expect(issueDialog(page)).toBeHidden();
    await expect(prDialog(page)).not.toContainText('Could not load');
  });

  test('from an issue body', async ({ page }) => {
    await open(page, 'issues', 'Fixed by #4177');
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();

    await expect(prDialog(page)).toContainText('The linked change.');
    await expect(issueDialog(page)).toBeHidden();
  });

  test('from a comment', async ({ page }) => {
    await open(page, 'issues', 'Body', ['See #4177 for the change.']);
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();

    await expect(prDialog(page)).toContainText('The linked change.');
  });

  test('a reference to an issue still opens an issue', async ({ page }) => {
    await open(page, 'pull-requests', 'Refs #4100');
    await prDialog(page).getByRole('link', { name: '#4100' }).click();

    await expect(issueDialog(page)).toContainText('An older issue.');
    await expect(prDialog(page)).toBeHidden();
  });

  test('a number that is neither says so in plain words', async ({ page }) => {
    await open(page, 'pull-requests', 'Refs #9999');
    await prDialog(page).getByRole('link', { name: '#9999' }).click();

    await expect(issueDialog(page)).toContainText(
      'issue or pull request not found: #9999',
    );
    await expect(issueDialog(page)).not.toContainText(/graphql/i);
  });

  test('a second open of a reference to a pull request is a pull request at once', async ({
    page,
  }) => {
    await open(page, 'issues', 'Fixed by #4177');
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();
    await expect(prDialog(page)).toContainText('The linked change.');
    await page.keyboard.press('Escape');

    // Only what was remembered can say what it is before the read returns.
    await page.evaluate(() => {
      const w = window as unknown as { __labels: string[] };
      w.__labels = [];
      new MutationObserver(() => {
        const d = document.querySelector('dialog.details-dialog[open]');
        const label = d?.getAttribute('aria-label') ?? '';
        if (label.includes('#4177')) w.__labels.push(label);
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'open'],
      });
    });
    await page.getByRole('button', { name: /^#12 / }).click();
    await issueDialog(page).getByRole('link', { name: '#4177' }).click();
    await expect(prDialog(page)).toBeVisible();
    const labels = await page.evaluate(
      () => (window as unknown as { __labels: string[] }).__labels,
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((l) => l.startsWith('Pull request details'))).toBe(
      true,
    );
  });

  for (const width of [360, 1280]) {
    test(`the retargeted dialog has no axe violations at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'issues', 'Fixed by #4177');
      await issueDialog(page).getByRole('link', { name: '#4177' }).click();
      await expect(prDialog(page)).toContainText('The linked change.');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
