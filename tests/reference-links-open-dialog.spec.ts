import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// #3744: an issue or pull request number opens its dialog in the dashboard.
// Only the explicit "Open on <forge>" style buttons go to the forge. A
// reference to a repository the dashboard doesn't track opens in the dialog
// when the forge can show it (#4269), and goes to the forge in a new tab, as
// its note says, when it can't.
// https://github.com/alrayyes/forge-dashboard/issues/3744

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
const details = (text: string) => ({
  description: body(text),
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
});

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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function open(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
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
      body: JSON.stringify(
        details('Fixes #12, see stranger/elsewhere#9 and `#7`.'),
      ),
    }),
  );
  await page.route('**/api/v1/issues/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...details('Issue text'), state: 'open' }),
    }),
  );
  await page.goto('/pull-requests.html');
  const trigger = page.getByRole('button', { name: /^#42 / });
  await trigger.click();
  return trigger;
}

const prDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });
const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });

test.describe('references open the dialog (#3744)', () => {
  test('the number in the dialog header is not a link to the forge', async ({
    page,
  }) => {
    await open(page);
    const header = prDialog(page).locator('.details-ref');
    await expect(header).toContainText('#42');
    await expect(header.getByRole('link', { name: /#42/ })).toHaveCount(0);
    // The footer's explicit button is the way to the forge.
    await expect(
      prDialog(page).getByRole('link', { name: /^Open on GitHub/ }),
    ).toHaveAttribute('href', pullRequest.url);
  });

  test("a #N for a tracked repository swaps in that item's dialog, with no navigation", async ({
    page,
  }) => {
    const trigger = await open(page);
    const link = prDialog(page).getByRole('link', { name: '#12' });
    // A real link to the dashboard, so middle-click and copy-link work.
    await expect(link).toHaveAttribute(
      'href',
      `/issues.html?issue=github/${REPO}/12`,
    );
    await expect(link).not.toHaveAttribute('target', /.*/);
    const before = page.url();

    await link.click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toContainText('Logging is noisy');
    await expect(prDialog(page)).toBeHidden();
    expect(page.url()).toBe(before);

    await page.keyboard.press('Escape');
    await expect(issueDialog(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('a modified click is left to the browser', async ({ page }) => {
    await open(page);
    const link = prDialog(page).getByRole('link', { name: '#12' });
    const popup = page.context().waitForEvent('page');
    await link.click({ modifiers: ['ControlOrMeta'] });
    await (await popup).close();
    await expect(prDialog(page)).toBeVisible();
  });

  // https://github.com/alrayyes/forge-dashboard/issues/4269
  // An item of an untracked repository stays a forge link. The forge is asked
  // while the pointer or focus rests on it; a click opens the dialog only if
  // that answer is in, and otherwise follows the link, which no browser blocks.
  const strangerLink = (page: Page) =>
    prDialog(page).getByRole('link', { name: /^stranger\/elsewhere#9/ });

  async function answerIssues(page: Page, status: number, text = 'Merged') {
    let asked = 0;
    await page.route('**/api/v1/issues/details*', (route: Route) => {
      asked++;
      const fullName = new URL(route.request().url()).searchParams.get(
        'fullName',
      );
      return route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(
          status === 200
            ? { ...details(`${text} text of ${fullName}`), state: 'closed' }
            : { error: 'not found' },
        ),
      });
    });
    return () => asked;
  }

  test('a mention the forge can show opens its dialog once the pointer has rested on it', async ({
    page,
  }) => {
    const trigger = await open(page);
    await answerIssues(page, 200);
    const link = strangerLink(page);
    // Still a forge link, for a middle click and for a click that is early.
    await expect(link).toHaveAttribute(
      'href',
      'https://github.com/stranger/elsewhere/issues/9',
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAccessibleName(
      'stranger/elsewhere#9 (opens on the forge in a new tab)',
    );
    const before = page.url();
    const answered = page.waitForResponse('**/api/v1/issues/details*');
    await link.hover();
    await answered;

    await link.click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toContainText(
      'Merged text of stranger/elsewhere',
    );
    await expect(prDialog(page)).toBeHidden();
    expect(page.context().pages()).toHaveLength(1);
    expect(page.url()).toBe(before);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(issueDialog(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('focus on the link asks the forge too, so Enter opens the dialog', async ({
    page,
  }) => {
    await open(page);
    await answerIssues(page, 200);
    const link = strangerLink(page);
    const answered = page.waitForResponse('**/api/v1/issues/details*');
    await link.focus();
    await answered;

    await page.keyboard.press('Enter');

    await expect(issueDialog(page)).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);
  });

  test('a mention the forge cannot show follows the link to the forge in a new tab', async ({
    page,
  }) => {
    await open(page);
    await answerIssues(page, 404);
    const link = strangerLink(page);
    const answered = page.waitForResponse('**/api/v1/issues/details*');
    await link.hover();
    await answered;
    const popup = page.context().waitForEvent('page');

    await link.click();

    const tab = await popup;
    await tab.waitForURL('https://github.com/stranger/elsewhere/issues/9', {
      waitUntil: 'commit',
    });
    await tab.close();
    // The dialog the reader was in is still there.
    await expect(prDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toBeHidden();
  });

  test('a click before the forge has answered follows the link, and a late answer opens nothing', async ({
    page,
  }) => {
    const trigger = await open(page);
    let answer: () => void = () => {};
    let asked = 0;
    await page.route('**/api/v1/issues/details*', async (route: Route) => {
      asked++;
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...details('Slow text'), state: 'closed' }),
      });
    });
    const link = strangerLink(page);
    await link.hover();
    await expect.poll(() => asked).toBe(1);
    const popup = page.context().waitForEvent('page');

    await link.click();

    const tab = await popup;
    await tab.waitForURL('https://github.com/stranger/elsewhere/issues/9', {
      waitUntil: 'commit',
    });
    await tab.close();
    await expect(prDialog(page)).toBeVisible();

    // The reader moves on; the answer then arrives. Nothing may open now or
    // when some later dialog closes.
    await page.keyboard.press('Escape');
    await expect(prDialog(page)).toBeHidden();
    answer();
    await expect(issueDialog(page)).toBeHidden();
    await trigger.click();
    await expect(prDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(prDialog(page)).toBeHidden();
    await expect(issueDialog(page)).toBeHidden();
  });

  test('a modified click on a warmed mention is left to the browser', async ({
    page,
  }) => {
    await open(page);
    await answerIssues(page, 200);
    const link = strangerLink(page);
    const answered = page.waitForResponse('**/api/v1/issues/details*');
    await link.hover();
    await answered;
    const popup = page.context().waitForEvent('page');

    await link.click({ modifiers: ['ControlOrMeta'] });

    await (await popup).close();
    await expect(prDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toBeHidden();
  });

  for (const width of [360, 390, 1280]) {
    test(`has no axe violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page);
      await expect(
        prDialog(page).getByRole('link', { name: '#12' }),
      ).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
