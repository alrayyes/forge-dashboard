import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// An issue row opens a dialog like a pull request's: the description and the
// conversation, fetched from GET /api/issues/details when it opens. Mocks
// /api/dashboard and the details endpoint only and writes no per-user state.

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const ISSUE = {
  forge: 'github',
  repo: 'alrayyes/forge-dashboard',
  number: 7,
  title: 'The page loses its place',
  url: 'https://example.com/issues/7',
  author: 'ryankes',
  authorAvatarUrl: 'https://avatars.example.com/u/7',
  labels: [{ name: 'bug', color: 'd73a4a' }],
  createdAt: ago(60),
  updatedAt: ago(5),
};

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

const details = {
  description: {
    text: 'It **jumps** back to the top.',
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
  },
  comments: [
    {
      id: 'c1',
      author: { login: 'demo-a', avatarUrl: 'https://example.invalid/a.png' },
      createdAt: ago(30),
      updatedAt: null,
      edited: false,
      text: 'Seen it too.',
      format: 'markdown',
      truncated: false,
      reactions: noReactions,
    },
  ],
  commentCount: 1,
  commentsTruncated: false,
};

const AVATAR = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#c0392b"/></svg>',
);

async function mockDashboard(page: Page, issue: object = ISSUE) {
  await page.route('https://avatars.example.com/u/7', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: AVATAR }),
  );
  await page.route('https://avatars.example.com/broken', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [issue],
      }),
    }),
  );
}

async function mockDetails(
  page: Page,
  status = 200,
  payload: unknown = details,
) {
  const urls: string[] = [];
  await page.route('**/api/issues/details*', (route: Route) => {
    urls.push(route.request().url());
    return route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  return urls;
}

const titleButton = (page: Page) =>
  page.locator('#issue-rows .row').getByRole('button', { name: /^#7 / });
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });

test.describe('an issue row opens its dialog', () => {
  test('the title is a button, and clicking it shows the description and comments', async ({
    page,
  }) => {
    await mockDashboard(page);
    const urls = await mockDetails(page);
    await page.goto('/issues.html');

    await expect(titleButton(page)).toHaveAccessibleName(
      '#7 The page loses its place',
    );
    await titleButton(page).click();

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAccessibleName(
      'Issue details: alrayyes/forge-dashboard #7',
    );
    await expect(dialog(page).locator('strong')).toHaveText('jumps');
    await expect(dialog(page).getByText('Seen it too.')).toBeVisible();
    await expect(dialog(page).getByText('Comments (1)')).toBeVisible();
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]);
    expect(url.searchParams.get('forge')).toBe('github');
    expect(url.searchParams.get('fullName')).toBe('alrayyes/forge-dashboard');
    expect(url.searchParams.get('number')).toBe('7');
  });

  test('the header says it is open and shows its labels, and the footer links to the forge and offers only the issue actions', async ({
    page,
  }) => {
    await mockDashboard(page);
    await mockDetails(page);
    await page.goto('/issues.html');
    await titleButton(page).click();

    await expect(dialog(page).getByText('Open', { exact: true })).toBeVisible();
    await expect(dialog(page).locator('.attr-chip.label')).toHaveText('bug');
    const link = dialog(page).getByRole('link', { name: /Open on GitHub/ });
    await expect(link).toHaveAttribute('href', 'https://example.com/issues/7');
    await expect(link).toHaveAttribute('target', '_blank');
    // An issue has no merge or rebase: it closes, with or without a comment.
    await expect(dialog(page).locator('.details-actions button')).toHaveText([
      'Close issue',
      'Close with a comment',
    ]);
  });

  test('the header says who filed it, with their avatar', async ({ page }) => {
    await mockDashboard(page);
    await mockDetails(page);
    await page.goto('/issues.html');
    await titleButton(page).click();

    const filedBy = dialog(page).locator('.details-author');
    await expect(filedBy).toContainText('ryankes');
    await expect(filedBy.locator('img')).toHaveAttribute(
      'src',
      'https://avatars.example.com/u/7',
    );
    // Decorative: the name beside it already says who.
    await expect(filedBy.locator('img')).toHaveAttribute('alt', '');
  });

  test('without a usable avatar the header shows the name alone', async ({
    page,
  }) => {
    for (const avatar of ['', 'http://avatars.example.com/u/7']) {
      await mockDashboard(page, { ...ISSUE, authorAvatarUrl: avatar });
      await mockDetails(page);
      await page.goto('/issues.html');
      await titleButton(page).click();

      const filedBy = dialog(page).locator('.details-author');
      await expect(filedBy).toContainText('ryankes');
      await expect(filedBy.locator('img')).toHaveCount(0);
      await dialog(page).getByRole('button', { name: 'Close details' }).click();
      await page.unroute('**/api/dashboard*');
      await page.unroute('**/api/issues/details*');
    }
  });

  test('an avatar that fails to load leaves the name alone', async ({
    page,
  }) => {
    await mockDashboard(page, {
      ...ISSUE,
      authorAvatarUrl: 'https://avatars.example.com/broken',
    });
    await mockDetails(page);
    await page.goto('/issues.html');
    await titleButton(page).click();

    const filedBy = dialog(page).locator('.details-author');
    await expect(filedBy).toContainText('ryankes');
    await expect(filedBy.locator('img')).toHaveCount(0);
  });

  test('says so plainly when there is no description and no comments', async ({
    page,
  }) => {
    await mockDashboard(page);
    await mockDetails(page, 200, {
      ...details,
      description: { ...details.description, text: '' },
      comments: [],
      commentCount: 0,
    });
    await page.goto('/issues.html');
    await titleButton(page).click();

    await expect(dialog(page).getByText('No description.')).toBeVisible();
    await expect(dialog(page).getByText('No comments.')).toBeVisible();
  });

  test('shows the error state, not an empty thread, when the forge fails, and loads on retry', async ({
    page,
  }) => {
    await mockDashboard(page);
    let fail = true;
    await page.route('**/api/issues/details*', (route: Route) =>
      fail
        ? route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'GitHub rate limited the request' }),
          })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(details),
          }),
    );
    await page.goto('/issues.html');
    await titleButton(page).click();

    await expect(dialog(page).getByRole('alert')).toContainText(
      'GitHub rate limited the request',
    );
    await expect(dialog(page).getByText('No description.')).toHaveCount(0);

    fail = false;
    await dialog(page).getByRole('button', { name: 'Try again' }).click();
    await expect(dialog(page).getByText('Seen it too.')).toBeVisible();
  });

  test('Escape closes it and focus returns to the issue', async ({ page }) => {
    await mockDashboard(page);
    await mockDetails(page);
    await page.goto('/issues.html');
    await titleButton(page).click();
    await expect(dialog(page)).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(dialog(page)).toBeHidden();
    await expect(titleButton(page)).toBeFocused();
  });

  test('the close button closes it and focus returns to the issue', async ({
    page,
  }) => {
    await mockDashboard(page);
    await mockDetails(page);
    await page.goto('/issues.html');
    await titleButton(page).click();
    await expect(dialog(page)).toBeVisible();

    await dialog(page).getByRole('button', { name: 'Close details' }).click();

    await expect(dialog(page)).toBeHidden();
    await expect(titleButton(page)).toBeFocused();
  });

  test('an open dialog follows the forge: Closed when the issue is closed, Open again when it is reopened', async ({
    page,
  }) => {
    // The snapshot lists open issues only: closing it removes the row, and
    // the details endpoint is the one that says what the forge has now.
    let forgeState: 'open' | 'closed' = 'open';
    await page.route('https://avatars.example.com/u/7', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: AVATAR,
      }),
    );
    await page.route('**/api/dashboard/stream*', (route) => route.abort());
    const snapshot = (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: new Date().toISOString(),
          forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
          pullRequests: [],
          issues:
            forgeState === 'open'
              ? [{ ...ISSUE, updatedAt: new Date().toISOString() }]
              : [],
        }),
      });
    await page.route('**/api/dashboard/refresh', snapshot);
    await page.route('**/api/dashboard*', snapshot);
    await page.route('**/api/issues/details*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...details, state: forgeState }),
      }),
    );
    const refresh = () =>
      page.evaluate(() =>
        document.querySelector<HTMLElement>('#force-refresh-button')?.click(),
      );
    const status = dialog(page).getByRole('group', { name: 'Status' });

    await page.goto('/issues.html');
    await titleButton(page).click();
    await expect(status).toHaveText('Open');

    forgeState = 'closed';
    await refresh();
    await expect(status).toHaveText('Closed');
    await expect(dialog(page)).toBeVisible();

    forgeState = 'open';
    await refresh();
    await expect(status).toHaveText('Open');

    forgeState = 'closed';
    await refresh();
    await expect(status).toHaveText('Closed');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      test(`has no axe violations with the dialog open in ${scheme} at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await mockDashboard(page);
        await mockDetails(page);
        await page.goto('/issues.html');
        await titleButton(page).click();
        await expect(dialog(page).getByText('Seen it too.')).toBeVisible();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        expect(results.violations).toEqual([]);
      });
    }
  }
});
