import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// An issue row opens a dialog like a pull request's: the description and the
// conversation, fetched from GET /api/issues/details when it opens. Mocks
// /api/dashboard and the details endpoint only and writes no per-user state,
// so it starts from the shared session.
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

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

async function mockDashboard(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [],
        issues: [ISSUE],
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

  test('the header says it is open and shows its labels, and the footer links to the forge only', async ({
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
    // An issue has no actions: no merge, close or rebase.
    await expect(dialog(page).locator('.details-actions button')).toHaveCount(
      0,
    );
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
