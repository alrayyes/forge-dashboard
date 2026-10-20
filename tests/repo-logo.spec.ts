import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// A repository's own logo shows beside its name on the pull request rows and
// on the Repositories page when the forge has one, and nothing otherwise.
// https://github.com/alrayyes/forge-dashboard/issues/2001

const LOGO = 'https://repository-images.githubusercontent.com/1/logo';
const BROKEN = 'https://repository-images.githubusercontent.com/1/broken';

const IMAGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#2c7a4b"/></svg>',
);

const REPOS = [
  { name: 'with-logo', logoUrl: LOGO },
  { name: 'no-logo', logoUrl: '' },
  { name: 'http-logo', logoUrl: 'http://repository-images.example.com/1/x' },
  { name: 'broken-logo', logoUrl: BROKEN },
];

function repo({ name, logoUrl }: { name: string; logoUrl: string }) {
  return {
    forge: 'github',
    fullName: `alrayyes/${name}`,
    url: `https://github.com/alrayyes/${name}`,
    ...(logoUrl ? { logoUrl } : {}),
    hasWebhook: false,
    canManageWebhooks: false,
    ignored: false,
    ignoredPRs: false,
    ignoredIssues: false,
    autoUpdateBranch: false,
  };
}

function pr(number: number, name: string) {
  return {
    forge: 'github',
    repo: `alrayyes/${name}`,
    number,
    title: `PR in ${name}`,
    url: `https://github.com/alrayyes/${name}/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
  };
}

async function mock(page: Page) {
  await page.route(LOGO, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: IMAGE }),
  );
  await page.route(BROKEN, (route: Route) => route.abort());
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: REPOS.length }],
        pullRequests: REPOS.map((r, i) => pr(i + 1, r.name)),
        issues: [],
        openIssueCount: 0,
        repos: REPOS.map(repo),
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function openRows(page: Page) {
  await mock(page);
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(REPOS.length);
}

const repoCell = (page: Page, name: string) =>
  page
    .locator('#pr-rows > .row', { hasText: `PR in ${name}` })
    .locator('.repo');

test.describe('Repository logo (#2001)', () => {
  // Writes nothing per user, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('a repository with a logo shows it left of the name on its rows', async ({
    page,
  }) => {
    await openRows(page);
    const cell = repoCell(page, 'with-logo');
    await expect(cell.locator('img.repo-logo')).toHaveAttribute('src', LOGO);
    await expect(cell.locator('.repo-name')).toHaveText('alrayyes/with-logo');
  });

  test('the logo is decorative, the name already says which repository', async ({
    page,
  }) => {
    await openRows(page);
    await expect(
      repoCell(page, 'with-logo').locator('img.repo-logo'),
    ).toHaveAttribute('alt', '');
  });

  test('a repository with no logo draws nothing extra', async ({ page }) => {
    await openRows(page);
    await expect(repoCell(page, 'no-logo').locator('img')).toHaveCount(0);
  });

  test('an http logo is never loaded', async ({ page }) => {
    await openRows(page);
    await expect(repoCell(page, 'http-logo').locator('img')).toHaveCount(0);
  });

  test('a logo that fails to load falls back to the name alone', async ({
    page,
  }) => {
    await openRows(page);
    const cell = repoCell(page, 'broken-logo');
    await expect(cell.locator('img')).toHaveCount(0);
    await expect(cell.locator('.repo-name')).toHaveText('alrayyes/broken-logo');
  });

  test('the Repositories page shows it beside the repository name too', async ({
    page,
  }) => {
    await mock(page);
    await page.goto('/webhooks.html');
    const rows = page.locator('#webhooks-rows tr');
    await expect(rows).toHaveCount(REPOS.length);
    await expect(
      rows.filter({ hasText: 'alrayyes/with-logo' }).locator('img.repo-logo'),
    ).toHaveAttribute('src', LOGO);
    await expect(
      rows.filter({ hasText: 'alrayyes/no-logo' }).locator('img'),
    ).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the Repositories page with a logo has no accessibility violations in ${scheme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mock(page);
      await page.goto('/webhooks.html');
      await expect(
        page
          .locator('#webhooks-rows tr', { hasText: 'alrayyes/with-logo' })
          .locator('img.repo-logo'),
      ).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });

    for (const width of [1280, 390]) {
      test(`rows with a logo have no accessibility violations in ${scheme} mode at ${width}px`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
        await openRows(page);
        await expect(
          repoCell(page, 'with-logo').locator('img.repo-logo'),
        ).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
