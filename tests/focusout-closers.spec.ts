import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// Pressing a non-focusable part of something that reacts to focus leaving it
// must not make it react (#4098). On a phone the nearest focusable ancestor of
// a press takes focus, and inside a scrolling sheet or dialog that is the
// scroller, outside the thing being pressed. #4093 found the filter panel
// closing on it. Each closer that listens for focusout is checked here, at
// desktop and phone width: the press is held down while the page's clock runs
// on, so a closer that reacted would show before the click.

const sizes = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
] as const;

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function pr(number: number, over: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title: `Change ${number}`,
    url: `https://example.com/${number}`,
    author: 'alice',
    draft: false,
    ci: 'success',
    mergeStatus: 'mergeable',
    labels: [],
    createdAt: ago(60),
    updatedAt: ago(number),
    behind: false,
    kind: 'regular',
    allowedActions: [{ action: 'merge', primary: true }, { action: 'close' }],
    ...over,
  };
}

const snapshot = (prs: Record<string, unknown>[]) => ({
  generatedAt: new Date().toISOString(),
  forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
  pullRequests: prs,
  issues: [],
  repos: [],
  hiddenDrafts: 0,
});

async function open(page: Page, prs: Record<string, unknown>[]) {
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
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({ json: snapshot(prs) }),
  );
  await page.goto('/pull-requests.html');
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

// Presses on the middle of a box and leaves the button down.
async function pressDown(page: Page, target: ReturnType<Page['locator']>) {
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to press');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

for (const size of sizes) {
  test.describe(`focus leaving a closer, ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('the confirm countdown keeps waiting while its hint is pressed', async ({
      page,
    }) => {
      await open(page, [pr(2)]);
      const row = page.locator('#pr-rows .row').first();
      const merge = row.getByRole('button', { name: 'Merge', exact: true });
      // Armed from the keyboard, so focus-visible pauses the countdown.
      await merge.focus();
      await page.keyboard.press('Enter');
      await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await page.clock.runFor(1500);
      const hint = row.locator('.confirm-hint');
      await pressDown(page, hint);
      // Past the 8s countdown, measured from the arm: still armed while held.
      await page.clock.runFor(8000);
      await expect(
        row.getByRole('button', { name: 'Confirm merge?' }),
      ).toBeVisible();
      await page.mouse.up();
    });

    test('rows stay put while a press is down, even with focus in another row', async ({
      page,
    }) => {
      const both = [pr(2), pr(1)];
      await open(page, both);
      const rows = page.locator('#pr-rows .row');
      await rows.nth(0).getByRole('button', { name: /^#2 / }).focus();
      await pressDown(page, rows.nth(1).locator('.repo, .meta, .age').first());
      // A snapshot that would move the rows lands only when nothing is held.
      await push(page, [pr(1), pr(2)]);
      await page.clock.runFor(1500);
      await expect(rows.nth(0)).toHaveAttribute('data-pr-key', /#2$/);
      await page.mouse.up();
    });

    test('a reaction list stays while its text is pressed, and goes when focus moves on', async ({
      page,
    }) => {
      const some = (logins: string[]) => ({ count: logins.length, logins });
      await open(page, [pr(2)]);
      await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
        route.fulfill({
          json: {
            description: {
              text: 'd',
              format: 'markdown',
              truncated: false,
              edited: false,
              reactions: {
                thumbsUp: some(['alice', 'bob']),
                thumbsDown: some(['carol']),
              },
            },
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            releaseNotes: null,
          },
        }),
      );
      await page
        .locator('#pr-rows .row')
        .first()
        .getByRole('button', { name: /^#\d+ / })
        .click();
      const dialog = page.getByRole('dialog', {
        name: /^Pull request details/,
      });
      const up = dialog.getByRole('group', { name: /^2 thumbs up/ });
      await up.focus();
      const list = dialog.locator('.reaction-people', { hasText: 'alice' });
      await expect(list).toBeVisible();
      await pressDown(page, list);
      await page.clock.runFor(500);
      await expect(list).toBeVisible();
      await page.mouse.up();
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await expect(list).toHaveCount(0);
    });

    test('an error toast keeps waiting while its text is pressed', async ({
      page,
    }) => {
      await page.route('**/api/v1/settings/bot-pr-updates', (route: Route) =>
        route.fulfill({ json: { allowBotPrUpdates: false } }),
      );
      await page.route(
        '**/api/v1/pull-requests/update-branch',
        (route: Route) =>
          route.fulfill({
            status: 403,
            json: { error: 'x', code: 'permission', message: 'No access' },
          }),
      );
      await open(page, [
        pr(2, {
          behind: true,
          ci: 'failure',
          mergeStatus: 'blocked',
          autoMergeEnabled: true,
          allowedActions: undefined,
        }),
      ]);
      await page
        .locator('#pr-rows .row')
        .first()
        .getByRole('button', { name: 'Update branch' })
        .click();
      const toast = page.locator('#feedback-toasts .feedback-toast').first();
      await expect(toast).toBeVisible();
      await toast.getByRole('button', { name: /^Dismiss/ }).focus();
      await pressDown(
        page,
        toast.locator('.feedback-toast-message, span, p').first(),
      );
      await page.clock.runFor(900);
      await expect(toast).toBeVisible();
      await page.mouse.up();
    });
  });
}
