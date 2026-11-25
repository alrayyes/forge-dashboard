import { expect, type Page, type Route } from '@playwright/test';
import {
  actionsFooter,
  openActionsDialog,
  viaActionsDialog,
} from './actions-dialog-helper';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Enable auto-merge on a stacked pull request is refused with `stacked` and
// locks until the parent merges. The next snapshot has to free it with no
// reload (#4925). The action state maps are cleared from one list in
// Dashboard.svelte; this spec fails if the auto-merge map is left off it.

function pr(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 839,
    title: 'Middle of the stack',
    url: 'https://example.com/839',
    author: 'claude',
    draft: false,
    ci: 'pending',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: false,
    autoMergeEnabled: false,
    ...overrides,
  };
}

function snapshot(prs: Record<string, unknown>[]) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [forgeHealth('github')],
    pullRequests: prs,
    issues: [],
    repos: [],
    hiddenDrafts: 0,
  };
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

test('a stacked lock on Enable auto-merge clears when the next snapshot has the parent merged', async ({
  page,
}) => {
  await page.clock.install();
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
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/settings/bot-pr-updates', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allowBotPrUpdates: false }),
    }),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        snapshot([
          pr({
            stackedOn: { number: 838, url: 'https://example.com/838' },
            allowedActions: [
              {
                action: 'merge',
                blocked: {
                  code: 'stacked',
                  message: 'Stacked on #838. Merge that one first.',
                  next: 'Merge unlocks once #838 merges.',
                },
              },
              { action: 'auto_merge' },
              { action: 'close' },
            ],
          }),
        ]),
      ),
    }),
  );
  await page.route('**/api/v1/pull-requests/auto-merge', (route: Route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'x',
        code: 'stacked',
        message: 'This pull request waits on #838. Merge that one first.',
      }),
    }),
  );
  await page.goto('/pull-requests.html');
  const row = page.locator('#pr-rows .row').first();
  await expect(row).toBeVisible();

  await viaActionsDialog(row, (footer) =>
    footer.getByRole('button', { name: 'Enable auto-merge' }).click(),
  );
  // The dialog closes after the click; reopen it to see the lock.
  const footer = actionsFooter(await openActionsDialog(row));
  const button = footer.getByRole('button', { name: 'Enable auto-merge' });
  await expect(button).toHaveAttribute('aria-disabled', 'true');

  // The parent merged: the same pull request, no longer stacked.
  await push(page, [pr({ stackedOn: null })]);
  await page.clock.runFor(300);

  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute('aria-disabled', 'true');
});
