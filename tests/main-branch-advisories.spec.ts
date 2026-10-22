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
  {
    ...row('acme/stale', {
      state: 'known',
      count: 2,
      highest: 'medium',
      url: 'https://example.com/acme/stale/security/dependabot',
    }),
    stale: true,
    staleSince: new Date(Date.now() - 3_600_000).toISOString(),
  },
  row('acme/unsafe', {
    state: 'known',
    count: 2,
    highest: 'high',
    url: 'javascript:alert(1)',
  }),
];

async function open(page: Page, branches: object[] = BRANCHES) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/main-branches', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
          failed: 0,
          passed: branches.length,
          running: 0,
          cancelled: 0,
          awaitingApproval: 0,
          none: 0,
          total: branches.length,
        },
        branches,
      }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('[data-testid="main-branch-row"]')).toHaveCount(
    branches.length,
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

  test('a mixed list marks unknown rows with a quiet cue, no pill and no notice', async ({
    page,
  }) => {
    await open(page);

    await expect(pill(page, 'acme/unsure')).toHaveCount(0);
    const cue = page
      .locator('[data-testid="main-branch-row"]', { hasText: 'acme/unsure' })
      .locator('[data-testid="main-branch-advisories-cue"]');
    await expect(cue).toHaveCount(1);
    await expect(cue).toHaveAccessibleName('Advisories unknown');
    await expect(page.getByTestId('advisories-notice')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="main-branch-advisories-cue"]'),
    ).toHaveCount(1);
  });

  test('when every answer is unknown, one notice names the cause and no row repeats it', async ({
    page,
  }) => {
    await open(page, [
      row('acme/a', { state: 'unknown', count: 0 }),
      row('acme/b', { state: 'unknown', count: 0 }),
      row('acme/nofield'),
    ]);

    const notice = page.getByTestId('advisories-notice');
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText('Dependabot alerts permission');
    // A rate limit or an outage reads as unknown too, and a new permission
    // takes a while to show: the notice owns up to both and names the way out.
    await expect(notice).toContainText(/rate\s+limit/i);
    await expect(notice).toContainText(
      /up\s+to\s+an\s+hour\s+and\s+a\s+quarter/i,
    );
    await expect(notice).toContainText(/saving\s+Settings/i);
    await expect(
      notice.getByRole('link', { name: /How to grant it/ }),
    ).toHaveAttribute(
      'href',
      /docs\/main-branches\.md#when-advisories-cant-be-read$/,
    );
    await expect(page.getByTestId('main-branch-advisories')).toHaveCount(0);
    await expect(page.getByTestId('main-branch-advisories-cue')).toHaveCount(0);
    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, `${theme} ${width}px`).toEqual([]);
      }
    }
    await setTheme(page, 'light');
  });

  test('a stale row keeps its pill beside the same stale chip every row gets', async ({
    page,
  }) => {
    await open(page);

    const stale = page.locator('[data-testid="main-branch-row"]', {
      hasText: 'acme/stale',
    });
    await expect(stale.locator('.mb-stale')).toHaveText('stale');
    await expect(
      stale.locator('[data-testid="main-branch-advisories"]'),
    ).toHaveText('2 advisories, medium');
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
          // An unlinked count is not interactive by design, so it keeps the
          // quiet 24px size rather than posing as a tap target.
          const unlinked = pill(page, 'acme/unsafe');
          await expect(unlinked).not.toHaveAttribute('href');
          expect(await unlinked.evaluate((el) => el.tagName)).toBe('SPAN');
        }
      }
    }
    await setTheme(page, 'light');
  });
});
