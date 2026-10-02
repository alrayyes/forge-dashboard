import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #705: Merge is always on an open pull request's row. Clickable when the
// forge says it can go, locked with a visible reason when it can't, and
// Close sits in "More actions" in every one of these states.

interface MockPR {
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  ci: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  mergeStatus: string;
  [key: string]: unknown;
}

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `pr-merge-states-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'PR Merge States Test User',
  );
}

function makePR(overrides?: Partial<MockPR>): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'mergeable',
    ...overrides,
  };
}

function mockDashboard(page: Page, pr: MockPR) {
  return page.route('**/api/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pr],
        issues: [],
      }),
    }),
  );
}

const rowOf = (page: Page) => page.locator('#pr-rows .row').first();

test.describe('Merge states on a pull request row', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('pending CI: Merge is locked with a visible reason and what happens next', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ ci: 'pending' }));
    await page.reload();

    const row = rowOf(page);
    const merge = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(merge).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByText('Waiting for CI to finish')).toBeVisible();
    await expect(row.getByText('Merge unlocks automatically')).toBeVisible();
    await expect(merge).toHaveAccessibleDescription(/Waiting for CI to finish/);
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  });

  test('pending CI: clicking the locked Merge does nothing', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ ci: 'pending' }));
    let mergeCalled = false;
    await page.route('**/api/pull-requests/merge', (route) => {
      mergeCalled = true;
      return route.fulfill({ status: 204 });
    });
    await page.reload();

    const row = rowOf(page);
    // force: Playwright otherwise waits forever for an aria-disabled button
    // to become enabled, and the click landing on it is the whole point.
    await row
      .getByRole('button', { name: 'Merge', exact: true })
      .click({ force: true });

    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toHaveCount(0);
    expect(mergeCalled).toBe(false);
  });

  test('pending CI: the locked Merge takes keyboard focus', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ ci: 'pending' }));
    await page.reload();

    const merge = rowOf(page).getByRole('button', {
      name: 'Merge',
      exact: true,
    });
    await merge.focus();
    await expect(merge).toBeFocused();
  });

  test('blocked with a failing check: Merge is locked and says the check is failing', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'failure' }),
    );
    await page.reload();

    const row = rowOf(page);
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByText('Blocked, CI is failing')).toBeVisible();
  });

  test('blocked with passing CI: the reason does not invent a failing check', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({ mergeStatus: 'blocked', ci: 'success' }),
    );
    await page.reload();

    const row = rowOf(page);
    await expect(row.getByText('Blocked by the forge')).toBeVisible();
    await expect(row.getByText(/CI is failing/)).toHaveCount(0);
  });

  test('conflicting: Merge is locked and names the conflict', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'conflicting' }));
    await page.reload();

    const row = rowOf(page);
    await expect(
      row.getByText('Merge conflict', { exact: true }),
    ).toBeVisible();
  });

  test('draft: Merge is locked and says to mark it ready', async ({ page }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'unknown', draft: true }));
    await page.reload();

    await expect(rowOf(page).getByText('Draft pull request')).toBeVisible();
  });

  test('unknown merge status: Merge is locked and says it is not known yet', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ mergeStatus: 'unknown' }));
    await page.reload();

    const row = rowOf(page);
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(row.getByText('Merge status not known yet')).toBeVisible();
  });

  test('ready: Merge is clickable and no reason is shown', async ({ page }) => {
    await mockDashboard(page, makePR());
    await page.reload();

    const row = rowOf(page);
    const merge = row.getByRole('button', { name: 'Merge', exact: true });
    await expect(merge).toBeEnabled();
    await expect(merge).not.toHaveAttribute('aria-disabled', 'true');
    await expect(row.locator('.row-action-note')).toHaveCount(0);
    await merge.click();
    await expect(
      row.getByRole('button', { name: 'Confirm merge?' }),
    ).toBeVisible();
  });

  for (const [name, overrides] of [
    ['pending', { ci: 'pending' }],
    ['blocked', { mergeStatus: 'blocked', ci: 'failure' }],
    ['ready', {}],
  ] as const) {
    test(`${name}: Close is only in More actions`, async ({ page }) => {
      await mockDashboard(page, makePR(overrides));
      await page.reload();

      const row = rowOf(page);
      await expect(
        row.getByRole('button', { name: 'Close', exact: true }),
      ).toHaveCount(0);
      await row.getByRole('button', { name: 'More actions' }).click();
      await expect(
        row
          .locator('.row-actions-popover')
          .getByRole('button', { name: 'Close', exact: true }),
      ).toBeVisible();
    });
  }

  test('a Renovate pull request waiting on CI keeps its bot layout, with Merge locked and Close in More actions', async ({
    page,
  }) => {
    await mockDashboard(
      page,
      makePR({
        author: 'renovate[bot]',
        title: 'chore(deps): update dependency foo to v2',
        ci: 'pending',
      }),
    );
    await page.reload();

    const row = rowOf(page);
    await expect(
      row.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(
      row.getByRole('button', { name: 'Close', exact: true }),
    ).toBeVisible();
  });

  for (const [name, overrides] of [
    ['pending', { ci: 'pending' }],
    ['blocked', { mergeStatus: 'blocked', ci: 'failure' }],
    ['ready', {}],
  ] as const) {
    test(`${name}: no axe-core violations`, async ({ page }) => {
      await mockDashboard(page, makePR(overrides));
      await page.reload();
      await expect(
        rowOf(page).getByRole('button', { name: 'Merge', exact: true }),
      ).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('axe-core finds nothing with the overflow menu open on a waiting row', async ({
    page,
  }) => {
    await mockDashboard(page, makePR({ ci: 'pending' }));
    await page.reload();
    await rowOf(page).getByRole('button', { name: 'More actions' }).click();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
