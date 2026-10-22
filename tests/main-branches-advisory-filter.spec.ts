import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';
import { setTheme } from './theme-helper';

// The Branches page filters on open advisories: any, has, or none. A row
// whose answer is unknown is under neither choice, and the control says how
// many are left out so nobody reads a missing row as clean.
// https://github.com/alrayyes/forge-dashboard/issues/2588

function row(
  fullName: string,
  advisories?: object,
  over: { forge?: string; status?: string } = {},
) {
  return {
    forge: over.forge ?? 'github',
    fullName,
    url: `https://example.com/${fullName}`,
    branch: 'main',
    status: over.status ?? 'passed',
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

const KNOWN = (count: number) => ({
  state: 'known',
  count,
  ...(count > 0 ? { highest: 'high' } : {}),
});
const UNKNOWN = { state: 'unknown', count: 0 };

const BRANCHES = [
  row('acme/vulnerable', KNOWN(2), { status: 'failed' }),
  row('acme/also-vulnerable', KNOWN(1), { forge: 'github' }),
  row('acme/clean', KNOWN(0)),
  row('infra/unsure', UNKNOWN, { forge: 'forgejo' }),
  row('acme/nofield'),
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
          failed: 1,
          passed: branches.length - 1,
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
  await expect(page.getByTestId('main-branch-row')).toHaveCount(
    branches.length,
  );
}

const group = (page: Page) =>
  page.getByRole('group', { name: 'Filter by advisories' });
const choice = (page: Page, name: RegExp) =>
  group(page).getByRole('button', { name });
const names = async (page: Page) =>
  (await page.getByTestId('main-branch-row').allTextContents()).map(
    (t) => t.match(/(acme|infra)\/[\w-]+/)?.[0],
  );

test.describe('Branches advisories filter (#2588)', () => {
  test('offers any, has and no advisories with counts, any by default', async ({
    page,
  }) => {
    await open(page);

    await expect(choice(page, /^Any advisories/)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(choice(page, /^Has advisories 2$/)).toBeVisible();
    await expect(choice(page, /^No advisories 1$/)).toBeVisible();
  });

  test('has keeps the rows with a count, no keeps the known zeros', async ({
    page,
  }) => {
    await open(page);

    await choice(page, /^Has advisories/).click();
    await expect(page.getByTestId('main-branch-row')).toHaveCount(2);
    expect(await names(page)).toEqual(
      expect.arrayContaining(['acme/vulnerable', 'acme/also-vulnerable']),
    );

    await choice(page, /^No advisories/).click();
    await expect(page.getByTestId('main-branch-row')).toHaveCount(1);
    await expect(page.getByTestId('main-branch-row')).toContainText(
      'acme/clean',
    );
  });

  test('unknown and absent answers are under neither, and the control counts them', async ({
    page,
  }) => {
    await open(page);

    const left = page.getByTestId('advisory-filter-unknown');
    await expect(left).toHaveText(
      '2 branches with unknown advisories are in neither choice',
    );
    for (const name of [/^Has advisories/, /^No advisories/]) {
      await choice(page, name).click();
      await expect(page.getByTestId('main-branch-row')).not.toContainText([
        'infra/unsure',
      ]);
      await expect(page.getByTestId('main-branch-row')).not.toContainText([
        'acme/nofield',
      ]);
    }
  });

  test('combines with status and search, and an empty result explains itself', async ({
    page,
  }) => {
    await open(page);

    await choice(page, /^Has advisories/).click();
    await page
      .locator('.mb-bar')
      .getByRole('button', { name: /^Failing/ })
      .click();
    await expect(page.getByTestId('main-branch-row')).toHaveCount(1);
    await expect(page.getByTestId('main-branch-row')).toContainText(
      'acme/vulnerable',
    );

    await page.getByRole('searchbox').fill('clean');
    await expect(page.getByTestId('no-match')).toContainText(
      'Nothing matches these filters.',
    );
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(page.getByTestId('main-branch-row')).toHaveCount(5);
    await expect(choice(page, /^Any advisories/)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('the choice is saved and survives a reload', async ({ page }) => {
    await open(page);

    await choice(page, /^No advisories/).click();
    await page.reload();
    await expect(page.getByTestId('main-branch-row')).toHaveCount(1);
    await expect(choice(page, /^No advisories/)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('is not offered when no row has an answer', async ({ page }) => {
    await open(page, [row('acme/a', UNKNOWN), row('acme/b')]);

    await expect(group(page)).toHaveCount(0);
  });

  test('is keyboard operable and has no axe violations', async ({ page }) => {
    await open(page);

    await choice(page, /^Has advisories/).focus();
    await page.keyboard.press('Enter');
    await expect(choice(page, /^Has advisories/)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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
});
