import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// A pull request row shows the author's avatar left of their name when the
// forge supplied one, and the plain name when it did not.
// https://github.com/alrayyes/forge-dashboard/issues/1913

const AVATAR = 'https://avatars.example.com/u/1';

const PIXEL = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#c0392b"/></svg>',
);

function pr(number: number, title: string, authorAvatarUrl: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://github.com/alrayyes/app/pull/${number}`,
    author: 'claude',
    authorAvatarUrl,
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
  };
}

const PRS = [
  pr(1, 'With avatar', AVATAR),
  pr(2, 'No avatar', ''),
  pr(3, 'Plain http avatar', 'http://avatars.example.com/u/3'),
  pr(4, 'Broken avatar', 'https://avatars.example.com/broken'),
];

async function open(page: Page) {
  await page.route('https://avatars.example.com/u/1', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PIXEL }),
  );
  await page.route('https://avatars.example.com/broken', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const author = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title }).locator('.author');

test.describe('Pull request row author avatar (#1913)', () => {
  // Writes nothing per user, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('shows the forge avatar next to the name', async ({ page }) => {
    await open(page);
    const cell = author(page, 'With avatar');
    await expect(cell.locator('img')).toHaveAttribute('src', AVATAR);
    await expect(cell).toContainText('claude');
  });

  test('the avatar is decorative, the name already says who', async ({
    page,
  }) => {
    await open(page);
    await expect(author(page, 'With avatar').locator('img')).toHaveAttribute(
      'alt',
      '',
    );
  });

  test('the narrow layout drops the whole author cell, avatar included', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await open(page);
    await expect(author(page, 'With avatar')).toBeHidden();
  });

  test('rows with avatars have no accessibility violations', async ({
    page,
  }) => {
    await open(page);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('no avatar shows the name alone', async ({ page }) => {
    await open(page);
    const cell = author(page, 'No avatar');
    await expect(cell).toHaveText('claude');
    await expect(cell.locator('img')).toHaveCount(0);
  });

  test('an http avatar is never loaded', async ({ page }) => {
    await open(page);
    await expect(author(page, 'Plain http avatar').locator('img')).toHaveCount(
      0,
    );
  });

  test('an avatar that fails to load falls back to the name alone', async ({
    page,
  }) => {
    await open(page);
    const cell = author(page, 'Broken avatar');
    await expect(cell.locator('img')).toHaveCount(0);
    await expect(cell).toHaveText('claude');
  });
});
