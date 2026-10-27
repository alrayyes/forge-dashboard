import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The Bots page header asks every listed, out-of-date bot pull request to
// rebase through the per-row actions. The plan (who counts, the labels) is
// pinned in bot-rebase-all.test.ts; these cases pin the wiring: the header,
// the confirm dialog, the requests made and a refusal staying on its row.

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'acme/app',
    number,
    title: `Bump dependency ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'dependabot[bot]',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    allowedActions: [{ action: 'dependabot_rebase' }],
    ...overrides,
  };
}

const renovate = (number: number) =>
  pr(number, {
    forge: 'forgejo',
    repo: 'acme/site',
    author: 'renovate[bot]',
    allowedActions: [{ action: 'renovate_rebase' }],
  });

async function open(page: Page, pullRequests: unknown[], forges?: unknown[]) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route(/\/api\/dashboard(\/refresh)?(\?.*)?$/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: forges ?? [
          { forge: 'github', reachable: true, repoCount: 1 },
          { forge: 'forgejo', reachable: true, repoCount: 1 },
        ],
        pullRequests,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  for (const endpoint of ['dependabot-action', 'renovate-rebase']) {
    await page.route(`**/api/pull-requests/${endpoint}`, (route: Route) => {
      const body = route.request().postDataJSON();
      posts.push({ url: route.request().url(), body });
      if (body.number === 3) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Not rebasable',
            code: 'not_mergeable',
            message: 'The pull request is not rebasable.',
          }),
        });
      }
      return route.fulfill({ status: 204 });
    });
  }
  await page.goto('/bots.html');
  return posts;
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('Rebase all counts the rows behind and asks each bot to rebase', async ({
  page,
}) => {
  const posts = await open(page, [
    pr(1),
    pr(2),
    renovate(4),
    pr(5, { behind: false }),
  ]);
  const button = page.getByRole('button', { name: 'Rebase all (3)' });
  await expect(button).toBeVisible();
  await expect(page.getByText('3 of 4 are out of date.')).toBeVisible();

  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Rebase 3 pull requests?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await expectNoAxeViolations(page);

  await dialog.getByRole('button', { name: 'Rebase', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => posts.length).toBe(3);
  expect(
    posts.map((p) => [p.url.split('/').pop(), p.body.number]).sort(),
  ).toEqual([
    ['dependabot-action', 1],
    ['dependabot-action', 2],
    ['renovate-rebase', 4],
  ]);
  expect(posts.find((p) => p.body.number === 1)?.body.action).toBe('rebase');
  await expect(
    page.getByRole('button', { name: 'Rebase all' }),
  ).toHaveAttribute('aria-disabled', 'true');
});

test('Cancel in the dialog asks for nothing', async ({ page }) => {
  const posts = await open(page, [pr(1)]);
  await page.getByRole('button', { name: 'Rebase all (1)' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(posts).toEqual([]);
});

test('a refused request stays on its row and the others go through', async ({
  page,
}) => {
  const posts = await open(page, [pr(1), pr(3), pr(2)]);
  await page.getByRole('button', { name: 'Rebase all (3)' }).click();
  await page.getByRole('button', { name: 'Rebase', exact: true }).click();
  await expect.poll(() => posts.length).toBe(3);
  const refused = page.locator('#pr-rows > .row', {
    hasText: 'Bump dependency 3',
  });
  await expect(refused).toContainText('not rebasable');
  await expect(page.locator('#rebase-all-status')).toHaveText(
    'Rebase requested for 2 of 3. 1 failed.',
  );
});

test('Rebase all shows only while something is out of date', async ({
  page,
}) => {
  await open(page, [pr(1, { behind: false }), renovate(4)]);
  const button = page.locator('#rebase-all-button');
  await expect(button).toBeVisible();
  await expectNoAxeViolations(page);

  // The filter hides the one row that is behind, while the button has focus.
  await button.focus();
  await page
    .locator('.quick-pill.forge-pill[data-pill="github"]')
    .evaluate((el) => {
      (el as HTMLElement).click();
    });
  await expect(button).toBeHidden();
  await expect(page.locator('#rebase-all-summary')).toBeHidden();
  await expect(
    page.locator('.filter-bar .quick-pills .quick-pill[data-pill="all"]'),
  ).toBeFocused();
  await expectNoAxeViolations(page);

  await page
    .locator('.filter-bar .quick-pills .quick-pill[data-pill="all"]')
    .click();
  await expect(button).toBeVisible();
});

test('Rebase all shows its progress through a run, then goes', async ({
  page,
}) => {
  const rows = [pr(1), pr(2)];
  await open(page, rows);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/pull-requests/dependabot-action', async (route) => {
    await held;
    await route.fulfill({ status: 204 });
  });
  await page.getByRole('button', { name: 'Rebase all (2)' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Rebase', exact: true })
    .click();
  await expect(page.locator('#rebase-all-button')).toHaveText(
    'Rebasing 0 of 2',
  );

  await expectNoAxeViolations(page);

  release();
  await expect(page.locator('#rebase-all-status')).toHaveText(
    'Rebase requested for 2.',
  );

  // The snapshot that follows finds nothing behind: no reload needed.
  for (const row of rows) row.behind = false;
  await page.locator('#force-refresh-button').click();
  await expect(page.locator('#rebase-all-button')).toBeHidden();
});

test('Dependabot rows on a GitHub App with no token are not counted', async ({
  page,
}) => {
  await open(
    page,
    [pr(1), renovate(4)],
    [
      {
        forge: 'github',
        reachable: true,
        repoCount: 1,
        dependabotCommandsBlocked: 'Dependabot needs a personal token.',
      },
      { forge: 'forgejo', reachable: true, repoCount: 1 },
    ],
  );
  await expect(
    page.getByRole('button', { name: 'Rebase all (1)' }),
  ).toBeVisible();
  await expect(
    page.getByText('Dependabot needs a personal token.').first(),
  ).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the header and dialog fit a phone in ${scheme} and pass axe`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 360, height: 800 });
    await open(page, [pr(1), renovate(4)]);
    await page.getByRole('button', { name: 'Rebase all (2)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoAxeViolations(page);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
}
