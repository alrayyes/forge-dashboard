import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// An issue row shows the avatar of whoever filed it left of their name when
// the forge supplied one, and the plain name when it did not, as a pull
// request row does.
// https://github.com/alrayyes/forge-dashboard/issues/2000

const AVATAR = 'https://avatars.example.com/u/1';

const PIXEL = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#c0392b"/></svg>',
);

function issue(number: number, title: string, authorAvatarUrl: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://github.com/alrayyes/app/issues/${number}`,
    author: 'claude',
    authorAvatarUrl,
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
  };
}

const ISSUES = [
  issue(1, 'With avatar', AVATAR),
  issue(2, 'No avatar', ''),
  issue(3, 'Plain http avatar', 'http://avatars.example.com/u/3'),
  issue(4, 'Broken avatar', 'https://avatars.example.com/broken'),
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
        pullRequests: [],
        issues: ISSUES,
        openIssueCount: ISSUES.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/issues.html');
  await expect(page.locator('#issue-rows > .row')).toHaveCount(ISSUES.length);
}

const author = (page: Page, title: string) =>
  page.locator('#issue-rows > .row', { hasText: title }).locator('.author');

test.describe('Issue row author avatar (#2000)', () => {
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

  for (const theme of ['light', 'dark'] as const) {
    test(`rows with avatars have no accessibility violations in ${theme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await open(page);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('rows have no accessibility violations on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
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
