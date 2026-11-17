import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { serveChecks } from './checks-feed-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The dialog takes its name from the visible heading, so the two can't drift
// apart (#3880).

const snapshot = () => ({
  generatedAt: new Date().toISOString(),
  forges: [forgeHealth('github', { capabilities: { label: 'GitHub' } })],
  pullRequests: [
    {
      forge: 'github',
      repo: 'example/app',
      number: 42,
      title: 'Add structured logging',
      url: 'https://example.com/42',
      author: 'claude',
      draft: false,
      ci: 'success',
      checks: { passed: 1, running: 0, waiting: 0, failed: 0 },
      labels: [],
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      mergeStatus: 'blocked',
      status: 'blocked',
      kind: 'regular',
      behind: false,
      allowedActions: [],
    },
  ],
  issues: [],
});

test.describe('pipeline dialog name', () => {
  test.beforeEach(async ({ page }) => {
    await serveChecks(page, () => [
      {
        name: 'job-1',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/example/app/actions/runs/9/job/1',
      },
    ]);
    await page.route('**/api/v1/dashboard', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot()),
      }),
    );
    await page.goto('/pull-requests.html');
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    await expect(page.locator('#pipeline-dialog .pipeline-check')).toHaveCount(
      1,
    );
  });

  test('aria-labelledby points at the visible h2 and no aria-label remains', async ({
    page,
  }) => {
    const dialog = page.locator('#pipeline-dialog');
    const heading = dialog.getByRole('heading', {
      level: 2,
      name: 'Pipeline checks',
    });
    const id = await heading.getAttribute('id');
    expect(id).toBeTruthy();
    await expect(dialog).toHaveAttribute('aria-labelledby', id as string);
    await expect(dialog).not.toHaveAttribute('aria-label', /.*/);
  });

  test('the accessible name equals the heading text', async ({ page }) => {
    const heading = page.locator('#pipeline-dialog h2');
    const text = (await heading.textContent())?.trim() ?? '';
    await expect(
      page.getByRole('dialog', { name: text, exact: true }),
    ).toBeVisible();
  });

  test('axe finds nothing', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
