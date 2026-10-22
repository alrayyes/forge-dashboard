import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// A row on the Branches page shows the repository's open dependency
// advisories when the server sends `advisories` on it: the count and highest
// severity as words, linking to the forge. A known zero draws nothing, an
// unknown answer says "unknown", and a row with no field has no pill.
// https://github.com/alrayyes/forge-dashboard/issues/2223

const DEPENDABOT = 'https://example.com/acme/critical/security/dependabot';

function row(fullName: string, advisories?: object) {
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
    latestRelease: null,
    stale: false,
    staleSince: null,
    ...(advisories ? { advisories } : {}),
  };
}

const BRANCHES = [
  row('acme/critical', {
    state: 'known',
    count: 3,
    highest: 'critical',
    url: DEPENDABOT,
  }),
  row('acme/single', {
    state: 'known',
    count: 1,
    highest: 'low',
    url: 'https://example.com/acme/single/security/dependabot',
  }),
  row('acme/clean', { state: 'known', count: 0 }),
  row('acme/unsure', { state: 'unknown', count: 0 }),
  row('acme/nofield'),
  row('acme/unsafe', {
    state: 'known',
    count: 2,
    highest: 'high',
    url: 'javascript:alert(1)',
  }),
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

const pill = (page: Page, repo: string) =>
  page
    .locator('[data-testid="main-branch-row"]', { hasText: repo })
    .locator('[data-testid="main-branch-advisories"]');

test.describe('Branches page advisories pill', () => {
  test('a known count shows the count and highest severity, linking out', async ({
    page,
  }) => {
    await open(page);

    const p = pill(page, 'acme/critical');
    await expect(p).toHaveText('3 advisories, critical');
    await expect(p).toHaveRole('link');
    await expect(p).toHaveAttribute('href', DEPENDABOT);
    await expect(p).toHaveAttribute('target', '_blank');
    await expect(p).toHaveAccessibleName(
      '3 advisories, critical (opens in a new tab)',
    );
    await expect(pill(page, 'acme/single')).toHaveText('1 advisory, low');
  });

  test('a known zero, and a row with no field, draw no pill', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'acme/clean')).toHaveCount(0);
    await expect(pill(page, 'acme/nofield')).toHaveCount(0);
  });

  test('unknown says unknown, not zero, and is not a link', async ({
    page,
  }) => {
    await open(page);

    const p = pill(page, 'acme/unsure');
    await expect(p).toHaveText('Advisories unknown');
    await expect(p).not.toHaveAttribute('href', /.*/);
    await expect(p).not.toContainText('0');
  });

  test('a url that is not http(s) leaves the count unlinked', async ({
    page,
  }) => {
    await open(page);

    const p = pill(page, 'acme/unsafe');
    await expect(p).toHaveText('2 advisories, high');
    await expect(p).not.toHaveAttribute('href', /.*/);
    await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0);
  });

  test('has no axe violations and no overflow, in both themes at 1280 and 390px', async ({
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
          const box = await pill(page, 'acme/critical').boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
        }
      }
    }
    await setTheme(page, 'light');
  });
});
