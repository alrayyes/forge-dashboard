import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// An out-of-date bot pull request offers its rebase in the row whatever Merge
// or auto-merge are waiting on, the same way for Renovate and Dependabot.
// Not behind, or conflicting, adds no button.

function pr(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number: 7,
    title: 'Bump a dependency',
    url: 'https://example.com/pull/7',
    author: 'renovate[bot]',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    ...overrides,
  };
}

async function open(page: Page, pullRequest: unknown) {
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [pullRequest],
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/bots.html');
  return page.locator('#pr-rows > .row').first();
}

const bots = [
  { name: 'Renovate', author: 'renovate[bot]', button: 'Renovate: Rebase' },
  {
    name: 'Dependabot',
    author: 'dependabot[bot]',
    button: 'Dependabot: Rebase',
  },
];

for (const { name, author, button } of bots) {
  test(`a behind ${name} pull request with failing CI has ${button} in its row`, async ({
    page,
  }) => {
    const row = await open(page, pr({ author, ci: 'failure' }));
    // Behind is what holds Merge, so the cure sits in the status line and
    // the row does not repeat it.
    await expect(row.getByRole('button', { name: button })).toHaveCount(1);
  });

  test(`a behind ${name} pull request waiting on CI has ${button} in its row`, async ({
    page,
  }) => {
    const row = await open(page, pr({ author }));
    const bar = row.locator('.row-action-bar');
    await expect(bar.getByRole('button', { name: button })).toBeVisible();
    await expect(row.getByRole('button', { name: button })).toHaveCount(1);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('a behind Renovate pull request waiting on CI with a rebase already requested keeps the locked button in its row', async ({
  page,
}) => {
  const row = await open(
    page,
    pr({
      allowedActions: [
        {
          action: 'merge',
          blocked: {
            code: 'checks_pending',
            message: 'Waiting for CI to finish',
          },
        },
        { action: 'close' },
        {
          action: 'renovate_rebase',
          blocked: {
            code: 'already_requested',
            message:
              'A Renovate rebase is already requested on this pull request.',
          },
        },
      ],
    }),
  );
  const button = row
    .locator('.row-action-bar')
    .getByRole('button', { name: 'Renovate: Rebase' });
  await expect(button).toHaveAttribute('aria-disabled', 'true');
});
