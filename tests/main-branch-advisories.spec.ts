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
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/main-branches', (route: Route) =>
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
  test('a known count shows the count and highest severity, opening the advisories', async ({
    page,
  }) => {
    await open(page);

    const p = pill(page, 'acme/critical');
    await expect(p).toHaveText('3 advisories, critical');
    await expect(p).toHaveRole('button');
    await expect(p).not.toHaveAttribute('href', /.*/);
    await expect(p).toHaveAccessibleName(
      '3 advisories, critical (opens the advisories)',
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

  test('a rate limit is named as the cause and sends nobody to permissions', async ({
    page,
  }) => {
    await open(page, [
      row('acme/a', { state: 'unknown', count: 0, reason: 'throttled' }),
      row('acme/b', { state: 'unknown', count: 0, reason: 'throttled' }),
    ]);

    const notice = page.getByTestId('advisories-notice');
    await expect(notice).toContainText(/rate\s+limiting/i);
    await expect(notice).not.toContainText('Dependabot alerts permission');
    await expect(notice.getByRole('link')).toHaveCount(0);
  });

  test('a refusal is named as the cause and keeps the way to grant it', async ({
    page,
  }) => {
    await open(page, [
      row('acme/a', { state: 'unknown', count: 0, reason: 'refused' }),
    ]);

    const notice = page.getByTestId('advisories-notice');
    await expect(notice).toContainText('refused the read');
    await expect(
      notice.getByRole('link', { name: /How to grant it/ }),
    ).toHaveCount(1);
  });

  test('a failed Forgejo read gets its own notice, with no GitHub permission advice', async ({
    page,
  }) => {
    const fj = (name: string, advisories?: object) => ({
      ...row(name, advisories),
      forge: 'forgejo',
    });
    await open(page, [
      row('acme/gh', { state: 'known', count: 0 }),
      fj('acme/a', { state: 'unknown', count: 0, reason: 'failed' }),
      fj('acme/b', { state: 'unknown', count: 0, reason: 'failed' }),
      // A repo with no lock file says nothing, and neither does a switched-off row.
      fj('acme/nolock', { state: 'unknown', count: 0 }),
    ]);

    const notice = page.getByTestId('forgejo-advisories-notice');
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText('Forgejo repositories');
    await expect(notice).toContainText('OSV could not be reached');
    await expect(notice).not.toContainText('permission');
    await expect(notice).not.toContainText('GitHub');
    await expect(page.getByTestId('advisories-notice')).toHaveCount(0);
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

  test('one unreadable Forgejo row among readable ones gets the quiet cue, not a notice', async ({
    page,
  }) => {
    const fj = (name: string, advisories?: object) => ({
      ...row(name, advisories),
      forge: 'forgejo',
    });
    await open(page, [
      fj('acme/a', { state: 'unknown', count: 0, reason: 'failed' }),
      fj('acme/b', { state: 'known', count: 0 }),
      fj('acme/nolock', { state: 'unknown', count: 0 }),
      fj('acme/off', { state: 'unknown', count: 0, reason: 'not_enabled' }),
    ]);

    await expect(page.getByTestId('forgejo-advisories-notice')).toHaveCount(0);
    await expect(page.getByTestId('main-branch-advisories-cue')).toHaveCount(1);
    await expect(
      page
        .locator('[data-testid="main-branch-row"]', { hasText: 'acme/a' })
        .getByTestId('main-branch-advisories-cue'),
    ).toHaveCount(1);
  });

  test('a Forgejo cue names why the row is unknown, and a GitHub cue keeps its plain name', async ({
    page,
  }) => {
    const fj = (name: string, advisories?: object) => ({
      ...row(name, advisories),
      forge: 'forgejo',
    });
    await open(page, [
      fj('acme/a', { state: 'unknown', count: 0, reason: 'failed' }),
      fj('acme/big', { state: 'unknown', count: 0, reason: 'too_many' }),
      fj('acme/b', { state: 'known', count: 0 }),
    ]);

    const cueOf = (repo: string) =>
      page
        .locator('[data-testid="main-branch-row"]', { hasText: repo })
        .getByTestId('main-branch-advisories-cue');
    await expect(cueOf('acme/a')).toHaveAccessibleName(
      'Advisories unknown: the read failed',
    );
    await expect(cueOf('acme/big')).toHaveAccessibleName(
      'Advisories unknown: too much to read',
    );
  });

  test('a failed GitHub row and a failed Forgejo row each get their own notice, and a GitHub-only page has no Forgejo cue', async ({
    page,
  }) => {
    const fj = (name: string, advisories?: object) => ({
      ...row(name, advisories),
      forge: 'forgejo',
    });
    await open(page, [
      row('acme/gh', { state: 'unknown', count: 0, reason: 'failed' }),
      fj('acme/fj', { state: 'unknown', count: 0, reason: 'failed' }),
    ]);

    await expect(page.getByTestId('advisories-notice')).toHaveCount(1);
    await expect(page.getByTestId('forgejo-advisories-notice')).toHaveCount(1);
    await expect(page.getByTestId('main-branch-advisories-cue')).toHaveCount(0);

    await open(page, [
      row('acme/gh', { state: 'unknown', count: 0, reason: 'failed' }),
      row('acme/ok', { state: 'known', count: 0 }),
    ]);
    await expect(page.getByTestId('forgejo-advisories-notice')).toHaveCount(0);
    await expect(page.getByTestId('advisories-notice')).toHaveCount(0);
    await expect(page.getByTestId('main-branch-advisories-cue')).toHaveCount(1);
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

  test('a count over a partly checked lock file reads as a floor, and a zero is not a clean bill', async ({
    page,
  }) => {
    await open(page, [
      row('acme/partial', {
        state: 'known',
        count: 3,
        highest: 'high',
        partial: true,
      }),
      row('acme/half-zero', { state: 'known', count: 0, partial: true }),
      row('acme/whole', { state: 'known', count: 3, highest: 'high' }),
    ]);

    const floor = pill(page, 'acme/partial');
    await expect(floor).toHaveText('At least 3 advisories, high');
    await expect(floor).toHaveAttribute('title', /not public/);
    await expect(pill(page, 'acme/half-zero')).toHaveText(
      'None found, partly checked',
    );
    await expect(pill(page, 'acme/whole')).toHaveText('3 advisories, high');
    await expect(pill(page, 'acme/whole')).not.toHaveAttribute('title', /.*/);
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
