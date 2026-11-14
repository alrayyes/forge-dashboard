import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// "Conflict not confirmed" is said once, as the pill, and the reason it opens
// names only what the row can do: Update branch when the row has the button,
// otherwise waiting or opening the pull request on the forge. While the forge
// can't be reached the rows may be earlier data and no action runs, so the reason
// says that instead.
// https://github.com/alrayyes/forge-dashboard/issues/3965

const TITLE = 'Conflict not confirmed';

const notConfirmed = (next: string) => ({
  action: 'merge',
  blocked: { code: 'conflict', message: TITLE, next },
});

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    forge: 'forgejo',
    repo: 'example/app',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/pull/${number}`,
    author: 'someone',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'conflicting',
    conflictConfirmed: false,
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

const NOT_BEHIND = pr(1, {
  title: 'Not behind',
  allowedActions: [
    notConfirmed(
      'The forge hasn’t confirmed it. Wait for it to finish checking, or open the pull request on the forge',
    ),
    { action: 'close' },
  ],
  status: {
    code: 'conflict',
    message: TITLE,
    next: 'The forge hasn’t confirmed it. Wait for it to finish checking, or open the pull request on the forge',
  },
});

const BEHIND = pr(2, {
  title: 'Behind',
  behind: true,
  allowedActions: [
    notConfirmed(
      'The forge hasn’t confirmed it. Update the branch to find out',
    ),
    { action: 'update_branch' },
    { action: 'close' },
  ],
  status: {
    code: 'conflict',
    message: TITLE,
    next: 'The forge hasn’t confirmed it. Update the branch to find out',
  },
});

async function open(page: Page, prs: unknown[], reachable = true) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [
          reachable
            ? { forge: 'forgejo', reachable: true, repoCount: 1 }
            : {
                forge: 'forgejo',
                reachable: false,
                repoCount: 1,
                errorKind: 'unreachable',
                error: 'timeout',
                staleSince: new Date(Date.now() - 10 * 60_000).toISOString(),
              },
        ],
        pullRequests: prs,
        issues: [],
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(prs.length);
}

const row = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title });

test('a row that is not behind says Conflict not confirmed once and never names Update branch', async ({
  page,
}) => {
  await open(page, [NOT_BEHIND]);
  const r = row(page, 'Not behind');
  await expect(r.getByText(TITLE)).toHaveCount(1);
  await expect(r.getByRole('button', { name: 'Update branch' })).toHaveCount(0);

  await r.getByRole('button', { name: TITLE }).click();
  const reason = r.locator('.merge-where');
  await expect(reason).toContainText('open the pull request on the forge');
  await expect(reason).not.toContainText('Update');
});

test('its Merge stays locked and its description says why', async ({
  page,
}) => {
  await open(page, [NOT_BEHIND]);
  const merge = row(page, 'Not behind').getByRole('button', {
    name: 'Merge',
    exact: true,
  });
  await expect(merge).toHaveAttribute('aria-disabled', 'true');
  await expect(merge).toHaveAccessibleDescription(/can't merge/);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('a behind row with a live Update branch says to use it, once', async ({
  page,
}) => {
  await open(page, [BEHIND]);
  const r = row(page, 'Behind');
  await expect(r.getByText(TITLE)).toHaveCount(1);
  await expect(r.getByRole('button', { name: 'Update branch' })).toHaveCount(1);
  await r.getByRole('button', { name: TITLE }).click();
  await expect(r.locator('.merge-where')).toContainText('Use Update branch');
});

test('while the forge is unreachable the reason says the rows are earlier data and no action runs', async ({
  page,
}) => {
  await open(page, [BEHIND], false);
  const r = row(page, 'Behind');
  await expect(r.getByText(TITLE)).toHaveCount(1);
  await expect(r.getByRole('button', { name: 'Update branch' })).toHaveCount(0);
  await r.getByRole('button', { name: TITLE }).click();
  const reason = r.locator('.merge-where');
  await expect(reason).toContainText("isn't answering");
  await expect(reason).toContainText('earlier');
  await expect(reason).not.toContainText('Use Update branch');
});
