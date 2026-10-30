import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// A row on the Branches page shows the repository's latest release when the
// server names one (`latestRelease` on each row of GET /api/v1/main-branches).
// Clicking it opens the details dialog with that release's title and notes
// (GET /api/v1/releases/details), read only when the dialog opens.
// https://github.com/alrayyes/forge-dashboard/issues/2083
// https://github.com/alrayyes/forge-dashboard/issues/2268

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
    staleSince: null,
  };
}

const BRANCHES = [
  row('acme/shipped', {
    tag: 'v1.2.3',
    url: 'https://example.com/acme/shipped/releases/tag/v1.2.3',
  }),
  row('acme/unreleased', null),
  row('acme/longtag', {
    tag: `release-candidate-${'x'.repeat(60)}-2026.10.20`,
    url: 'https://example.com/acme/longtag/releases/tag/long',
  }),
  row('acme/oddtag', {
    tag: 'v1.0/rc 1',
    url: 'https://example.com/acme/oddtag/releases/tag/odd',
  }),
  row('acme/unsafe', {
    tag: 'v9.9.9',
    url: 'javascript:alert(1)',
  }),
];

function releaseBody(notes: string, name = 'Spring cleaning') {
  return JSON.stringify({
    tag: 'v1.2.3',
    name,
    url: 'https://example.com/acme/shipped/releases/tag/v1.2.3',
    publishedAt: '2026-10-01T10:00:00Z',
    notes: {
      text: notes,
      format: 'markdown',
      truncated: false,
      edited: false,
      reactions: {
        thumbsUp: { count: 0, logins: [] },
        thumbsDown: { count: 0, logins: [] },
      },
    },
  });
}

async function open(
  page: Page,
  notes = '## Fixes\n- The page keeps its place.',
  details: (route: Route) => Promise<void> | void = (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: releaseBody(notes),
    }),
) {
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/releases/details*', details);
  await page.route('**/api/v1/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 0,
          passed: BRANCHES.length,
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
  test('a repository with a release shows a button named by its tag', async ({
    page,
  }) => {
    await open(page);

    const tag = releaseLink(page, 'acme/shipped');
    await expect(tag).toHaveText('v1.2.3');
    await expect(tag).toHaveRole('button');
    await expect(tag).toHaveAccessibleName(
      'Latest release v1.2.3, open details',
    );
  });

  test('clicking the tag opens the release dialog with its title and notes', async ({
    page,
  }) => {
    await open(page);

    await releaseLink(page, 'acme/shipped').click();

    const dialog = page.locator('dialog.details-dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'Spring cleaning' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'Release notes' }),
    ).toBeVisible();
    await expect(dialog.getByText('The page keeps its place.')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /Comments/ })).toHaveCount(
      0,
    );
    await expect(
      dialog.getByRole('link', { name: /Open on GitHub/ }),
    ).toHaveAttribute(
      'href',
      'https://example.com/acme/shipped/releases/tag/v1.2.3',
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('Escape and Close close it and focus returns to the tag', async ({
    page,
  }) => {
    await open(page);
    const tag = releaseLink(page, 'acme/shipped');
    const dialog = page.locator('dialog.details-dialog');

    await tag.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(tag).toBeFocused();

    await tag.click();
    await dialog.getByRole('button', { name: 'Close details' }).click();
    await expect(dialog).toBeHidden();
    await expect(tag).toBeFocused();
  });

  test('a release with no notes says so', async ({ page }) => {
    await open(page, '');

    await releaseLink(page, 'acme/shipped').click();

    await expect(
      page.locator('dialog.details-dialog').getByText('No release notes.'),
    ).toBeVisible();
  });

  test('a release the server cannot find shows the error, and a tag with a slash and a space is sent encoded', async ({
    page,
  }) => {
    const urls: string[] = [];
    await open(page, '', (route) => {
      urls.push(route.request().url());

      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'release not found' }),
      });
    });

    await releaseLink(page, 'acme/oddtag').click();

    const dialog = page.locator('dialog.details-dialog');
    await expect(dialog.getByRole('alert')).toContainText(
      'Could not load the details: release not found',
    );
    await expect(
      dialog.getByRole('heading', { name: 'Release notes' }),
    ).toHaveCount(0);
    expect(new URL(urls[0]).searchParams.get('tag')).toBe('v1.0/rc 1');
    expect(urls[0]).toContain('tag=v1.0%2Frc%201');
  });

  test('a slow first release answering after a second was opened does not replace it', async ({
    page,
  }) => {
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await open(page, '', async (route) => {
      const tag = new URL(route.request().url()).searchParams.get('tag');
      if (tag === 'v1.2.3') {
        await firstHeld;

        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: releaseBody('First notes.', 'First release'),
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: releaseBody('Second notes.', 'Second release'),
      });
    });
    const dialog = page.locator('dialog.details-dialog');

    await releaseLink(page, 'acme/shipped').click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await releaseLink(page, 'acme/oddtag').click();
    await expect(
      dialog.getByRole('heading', { name: 'Second release' }),
    ).toBeVisible();
    const firstAnswer = page.waitForResponse((res) =>
      res.url().includes('tag=v1.2.3'),
    );
    releaseFirst();
    await firstAnswer;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    await expect(
      dialog.getByRole('heading', { name: 'Second release' }),
    ).toBeVisible();
    await expect(dialog.getByText('Second notes.')).toBeVisible();
    await expect(dialog.getByText('First notes.')).toHaveCount(0);
  });

  test('a repository with no release shows no link', async ({ page }) => {
    await open(page);

    await expect(releaseLink(page, 'acme/unreleased')).toHaveCount(0);
  });

  test('a release url that is not http(s) renders no tag', async ({ page }) => {
    await open(page);

    await expect(releaseLink(page, 'acme/unsafe')).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0);
  });

  test('a long tag is cut to one line on a phone, with the full tag on hover and no overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);

    const link = releaseLink(page, 'acme/longtag');
    const tag = `release-candidate-${'x'.repeat(60)}-2026.10.20`;
    await expect(link).toHaveAttribute('title', tag);
    await expect(link).toHaveAccessibleName(
      `Latest release ${tag}, open details`,
    );
    const box = await link.boundingBox();
    expect(box?.height).toBeLessThanOrEqual(48);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
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
