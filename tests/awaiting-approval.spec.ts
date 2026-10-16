import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// #1280: a GitHub pull request whose workflow runs are held until someone
// approves them says so, and links to its checks page to approve there.
// https://github.com/alrayyes/forge-dashboard/issues/1280

function pr(number: number, title: string, awaiting: boolean) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://github.com/alrayyes/app/pull/${number}`,
    author: 'claude',
    draft: false,
    ci: 'failure',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
    awaitingWorkflowApproval: awaiting,
  };
}

const PRS = [pr(1, 'Held for approval', true), pr(2, 'Really failing', false)];

async function open(page: Page) {
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

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

test.describe('Awaiting workflow approval (#1280)', () => {
  // Writes nothing per user, so it starts from the shared session (#1379).
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('a held row says so and links to its checks page', async ({ page }) => {
    await open(page);
    const held = row(page, 'Held for approval');
    await expect(
      held.getByRole('button', { name: /Waiting for workflow approval/ }),
    ).toBeVisible();
    await expect(held.locator('.ci-pill')).not.toContainText('Failed');
    const link = held.getByRole('link', { name: /approve.*GitHub/i });
    await expect(link).toHaveAttribute(
      'href',
      'https://github.com/alrayyes/app/pull/1/checks',
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    // The pipeline panel stays reachable from the pill.
    await held
      .getByRole('button', { name: /Waiting for workflow approval/ })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('a failing row without the flag is unchanged', async ({ page }) => {
    await open(page);
    const failing = row(page, 'Really failing');
    await expect(failing.locator('.ci-pill')).toHaveText('Failed');
    await expect(
      failing.getByRole('link', { name: /approve.*GitHub/i }),
    ).toHaveCount(0);
  });

  test('the link is a 44px target on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await open(page);
    const link = row(page, 'Held for approval').getByRole('link', {
      name: /approve.*GitHub/i,
    });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`has no axe violations in ${theme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await open(page);
      await expect(
        row(page, 'Held for approval').getByRole('link', {
          name: /approve.*GitHub/i,
        }),
      ).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
