import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #918: a failed action's line stays on its row until it is dismissed or the
// row is acted on again, however many snapshots arrive, and a permission
// refusal locks only that action on that pull request.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `failure-stays-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Failure Stays');
}

function pr(number: number, over: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/Hush-Hush',
    number,
    title: `Workflow change ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft: false,
    ci: 'failure',
    mergeStatus: 'blocked',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    behind: true,
    autoMergeEnabled: true,
    ...over,
  };
}

function snapshot(prs: Record<string, unknown>[]) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: prs,
    issues: [],
    repos: [],
    hiddenDrafts: 0,
  };
}

async function open(page: Page, prs: Record<string, unknown>[]) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: false }),
    }),
  );
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(prs)),
    }),
  );
  await page.route('**/api/pull-requests/update-branch', (route: Route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'x',
        code: 'permission',
        message: 'Resource not accessible by integration',
      }),
    }),
  );
  await page.reload();
  await expect(page.locator('#pr-rows .row')).toHaveCount(prs.length);
}

async function push(page: Page, prs: Record<string, unknown>[]) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify(snapshot(prs)),
  );
}

const rowFor = (page: Page, n: number) =>
  page.locator(`#pr-rows .row[data-pr-key$="#${n}"]`);

test.describe('a failure line stays until dismissed (#918)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('the line survives snapshots, including ones that change the row', async ({
    page,
  }) => {
    const first = [pr(613), pr(603)];
    await open(page, first);

    await rowFor(page, 613)
      .getByRole('button', { name: 'Update branch' })
      .click();
    const line = rowFor(page, 613).locator('.row-feedback-line');
    await expect(line).toContainText('Missing permission');

    // Snapshots keep arriving, some changing the row's own fields.
    const updates = [
      first,
      [pr(613, { ci: 'pending' }), pr(603)],
      [pr(613, { ci: 'pending', behind: false }), pr(603)],
      [
        pr(613, {
          ci: 'failure',
          behind: true,
          updatedAt: new Date().toISOString(),
        }),
        pr(603),
      ],
      first,
    ];
    for (const prs of updates) {
      await push(page, prs);
      await page.waitForTimeout(250);
      await expect(line).toBeVisible();
      await expect(line).toContainText('Missing permission');
    }

    await line.getByRole('button', { name: /^Dismiss/ }).click();
    await expect(line).toHaveCount(0);
  });

  test('the line survives a snapshot that leaves the pull request out for a moment', async ({
    page,
  }) => {
    const both = [pr(613), pr(603)];
    await open(page, both);

    await rowFor(page, 613)
      .getByRole('button', { name: 'Update branch' })
      .click();
    const line = rowFor(page, 613).locator('.row-feedback-line');
    await expect(line).toContainText('Missing permission');

    // The row stays on screen (rows don't move until asked), so its line must too.
    await push(page, [pr(603)]);
    await page.waitForTimeout(300);
    await push(page, both);
    await page.waitForTimeout(300);

    await expect(rowFor(page, 613)).toHaveCount(1);
    await expect(line).toBeVisible();
  });

  test('a permission refusal locks only that action on that pull request, across snapshots', async ({
    page,
  }) => {
    const both = [pr(613), pr(603)];
    await open(page, both);

    await rowFor(page, 613)
      .getByRole('button', { name: 'Update branch' })
      .click();
    await expect(rowFor(page, 613).locator('.row-feedback-line')).toBeVisible();
    await push(page, both);
    await page.waitForTimeout(300);

    // #613's own Update branch stays locked, with its reason.
    const refused = rowFor(page, 613).getByRole('button', {
      name: 'Update branch',
    });
    await expect(refused).toHaveAttribute('aria-disabled', 'true');

    // The other pull request's is still a real, clickable one.
    const other = rowFor(page, 603).getByRole('button', {
      name: 'Update branch',
    });
    await expect(other).toBeVisible();
    await expect(other).not.toHaveAttribute('aria-disabled', 'true');
    await expect(rowFor(page, 603)).not.toContainText('Missing permission');
  });

  test('dismissing the line frees the action without a reload', async ({
    page,
  }) => {
    await open(page, [pr(613)]);

    await rowFor(page, 613)
      .getByRole('button', { name: 'Update branch' })
      .click();
    const line = rowFor(page, 613).locator('.row-feedback-line');
    await expect(line).toBeVisible();
    await line.getByRole('button', { name: /^Dismiss/ }).click();

    const again = rowFor(page, 613).getByRole('button', {
      name: 'Update branch',
    });
    await expect(again).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('at phone width the line wraps, has no axe violations and stays through snapshots', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const both = [pr(613), pr(603)];
    await open(page, both);

    await rowFor(page, 613)
      .getByRole('button', { name: 'Update branch' })
      .click();
    const line = rowFor(page, 613).locator('.row-feedback-line');
    await expect(line).toBeVisible();
    await push(page, both);
    await push(page, [pr(613, { ci: 'pending' }), pr(603)]);
    await page.waitForTimeout(300);
    await expect(line).toBeVisible();

    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
