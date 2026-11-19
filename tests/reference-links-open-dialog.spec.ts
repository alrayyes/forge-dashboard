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
  test('a reference to an untracked repository the forge can show opens its dialog', async ({
    page,
  }) => {
    const trigger = await open(page);
    await page.route('**/api/v1/issues/details*', (route: Route) => {
      const asked = new URL(route.request().url()).searchParams;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...details(`Merged text of ${asked.get('fullName')}`),
          state: 'closed',
        }),
      });
    });
    const link = prDialog(page).getByRole('link', {
      name: /^stranger\/elsewhere#9/,
    });
    // Still a forge link, for a middle click and for a failed lookup.
    await expect(link).toHaveAttribute(
      'href',
      'https://github.com/stranger/elsewhere/issues/9',
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAccessibleName(
      'stranger/elsewhere#9 (opens on the forge in a new tab)',
    );
    const before = page.url();

    await link.click();

    await expect(issueDialog(page)).toBeVisible();
    await expect(issueDialog(page)).toContainText(
      'Merged text of stranger/elsewhere',
    );
    await expect(prDialog(page)).toBeHidden();
    expect(page.url()).toBe(before);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(issueDialog(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('a reference the forge cannot show falls back to the forge in a new tab', async ({
    page,
  }) => {
    await open(page);
    await page.route('**/api/v1/issues/details*', (route: Route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not found' }),
      }),
    );
    const link = prDialog(page).getByRole('link', {
      name: /^stranger\/elsewhere#9/,
    });
    const popup = page.context().waitForEvent('page');

    await link.click();

    const tab = await popup;
    expect(tab.url()).toBe('https://github.com/stranger/elsewhere/issues/9');
    await tab.close();
    // The dialog the reader was in is still there.
    await expect(prDialog(page)).toBeVisible();
    await expect(link).toHaveAccessibleName(
      'stranger/elsewhere#9 (opens on the forge in a new tab)',
    );
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
