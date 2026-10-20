import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { setTheme } from './theme-helper';

// A row on the Branches page links to the repository's latest release when the
// server names one (`latestRelease` on each row of GET /api/main-branches). The
// page only draws it: nothing is looked up in the browser.
// https://github.com/alrayyes/forge-dashboard/issues/2083

function row(
  fullName: string,
  latestRelease: { tag: string; url: string } | null,
) {
  return {
    forge: 'github',
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status: 'passed',
    commit: {
      sha: 'd98f3c2',
      subject: `fix: change in ${fullName}`,
      author: 'sre-dev',
      committedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    failingJobs: [],
    finishedAt: null,
    durationSeconds: null,
    runUrl: `https://example.com/${fullName}/actions/runs/1`,
    checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
    latestRelease,
    stale: false,
    staleSince: null,
  };
}

const BRANCHES = [
  row('acme/shipped', {
    tag: 'v1.2.3',
    url: 'https://example.com/acme/shipped/releases/tag/v1.2.3',
  }),
  row('acme/unreleased', null),
];

async function open(page: Page) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 0,
          passed: 2,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: BRANCHES.length,
        },
        branches: BRANCHES,
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
    BRANCHES.length,
  );
}

const rowOf = (page: Page, repo: string) =>
  page.locator('[data-testid="main-branch-row"]', { hasText: repo });
const releaseLink = (page: Page, repo: string) =>
  rowOf(page, repo).locator('[data-testid="main-branch-release"]');

test.describe('Branches page latest release link', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    const username = `branch-release-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await registerViaInvite(
      page,
      request,
      baseURL as string | undefined,
      username,
      'Branch Release',
    );
  });

  test('a repository with a release links to it, named by its tag', async ({
    page,
  }) => {
    await open(page);

    const link = releaseLink(page, 'acme/shipped');
    await expect(link).toHaveText('v1.2.3');
    await expect(link).toHaveAttribute(
      'href',
      'https://example.com/acme/shipped/releases/tag/v1.2.3',
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAccessibleName(
      'Latest release v1.2.3 (opens in a new tab)',
    );
  });

  test('a repository with no release shows no link', async ({ page }) => {
    await open(page);

    await expect(releaseLink(page, 'acme/unreleased')).toHaveCount(0);
  });

  test('has no axe violations, 44px target and no overflow at 390px', async ({
    page,
  }) => {
    await open(page);

    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await page.reload();
      await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
        BRANCHES.length,
      );
      for (const size of [
        { width: 1280, height: 800 },
        { width: 390, height: 800 },
      ]) {
        await page.setViewportSize(size);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, `${theme} ${size.width}px`).toEqual([]);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${theme} ${size.width}px`).toBeLessThanOrEqual(0);
        if (size.width === 390) {
          const box = await releaseLink(page, 'acme/shipped').boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
        }
      }
    }
    await setTheme(page, 'light');
  });
});
