import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// An out-of-date bot pull request offers its rebase in the row whatever Merge
// or auto-merge are waiting on, the same way for Renovate and Dependabot.
// The Go table in primary_action_test.go pins the rule; these cases pin the
// wiring: the button's place in the row, its accessible name and a held-run
// pull request with no rebase. The locked already-requested button is covered
// in renovate-rebase-requested.spec.ts.

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

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
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
    // Merge is open as unstable only because the failing checks aren't
    // required, so the rebase is the row's own button, not part of a status line.
    const row = await open(
      page,
      pr({ author, ci: 'failure', mergeStatus: 'unstable' }),
    );
    await expect(
      row.locator('.row-action-bar').getByRole('button', { name: button }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: button })).toHaveCount(1);
    await expectNoAxeViolations(page);
  });

  test(`a behind ${name} pull request waiting on CI has ${button} in its row`, async ({
    page,
  }) => {
    const row = await open(page, pr({ author }));
    const bar = row.locator('.row-action-bar');
    await expect(bar.getByRole('button', { name: button })).toBeVisible();
    await expect(row.getByRole('button', { name: button })).toHaveCount(1);
    await expectNoAxeViolations(page);
  });

  test(`a behind ${name} pull request fits a 360px row with ${button} reachable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const row = await open(page, pr({ author }));
    const button_ = row
      .locator('.row-action-bar')
      .getByRole('button', { name: button });
    await expect(button_).toBeVisible();
    await button_.scrollIntoViewIfNeeded();
    await expect(button_).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expectNoAxeViolations(page);
  });
}

const approval = {
  code: 'blocked_by_protection',
  message: 'Workflow runs are waiting for approval',
  next: 'Approve them on GitHub to unlock Merge',
};
// What the server lists on the actions that would push a held head.
const headPush = {
  ...approval,
  next: 'Approve them on GitHub, then this can run',
};

test('a behind bot pull request waiting for workflow approval has its rebase and Recreate locked and says why', async ({
  page,
}) => {
  const row = await open(
    page,
    pr({
      author: 'dependabot[bot]',
      ci: 'failure',
      awaitingWorkflowApproval: true,
      // What the server answers for this state (pinned in its Go tests).
      allowedActions: [
        { action: 'merge', blocked: approval },
        { action: 'close' },
        { action: 'dependabot_rebase', blocked: headPush },
        { action: 'dependabot_recreate', blocked: headPush },
      ],
      status: approval,
    }),
  );
  await expect(row.locator('.status-area')).toContainText(
    'Workflow runs are waiting for approval',
  );
  // Listed blocked, so Rebase stays on the row locked with the reason, and
  // Recreate is locked the same way in its menu: neither can send a command
  // the server would refuse.
  const reason = 'Workflow runs are waiting for approval';
  const rebase = row.getByRole('button', { name: 'Dependabot: Rebase' });
  await expect(rebase).toHaveAttribute('aria-disabled', 'true');
  await expect(rebase).toHaveAccessibleDescription(reason);
  await row.getByRole('button', { name: 'More Dependabot actions' }).click();
  const recreate = row.getByRole('menuitem', { name: 'Dependabot: Recreate' });
  await expect(recreate).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toContainText(reason);
  await expectNoAxeViolations(page);
});
