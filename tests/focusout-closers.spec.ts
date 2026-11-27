import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// Does anything that listens for focus leaving react to a press on a
// non-focusable part of it (#4098)? On a phone a press moves focus to the
// nearest focusable ancestor, which can be a scroller outside the thing
// pressed; #4093 found the filter panel closing on that. Covered here, at
// desktop and phone width: the confirm countdown (Dashboard.svelte, focusout
// on the document), the row lists' hold, the success toast's timer, and the
// reaction list. The confirm and rows tests stay green with their focusout
// handlers mutated, because focusin re-pauses the countdown and the hold
// outlasts the handler: they pin behaviour, they do not prove the handler
// is needed. Not covered: the failure line's timer (feedback-ui.ts, the
// handler near line 409), which has the same shape as the toast's.
// The press is sent as touch pointer events plus the blur a press causes,
// because Playwright cannot hold a finger down and a mouse press brings
// hover with it, which pauses the same timers and hides the bug.

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
  forges: [forgeHealth('github')],
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

// A finger pressing `target`: the touch pointer events, and the blur a press
// causes when the nearest focusable ancestor is not the focused element.
async function touchDown(target: ReturnType<Page['locator']>) {
  await target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const init = (type: string) =>
      new PointerEvent(type, {
        pointerId: 9,
        pointerType: 'touch',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      });
    el.dispatchEvent(init('pointerover'));
    el.dispatchEvent(init('pointerdown'));
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

for (const size of sizes) {
  test.describe(`focus leaving a closer, ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('the confirm countdown keeps waiting while focus moves inside the group, or a finger presses its hint', async ({
      page,
    }) => {
      await open(page, [pr(2)]);
      const row = page.locator('#pr-rows .row').first();
      const merge = row.getByRole('button', { name: 'Merge', exact: true });
      const confirm = row.getByRole('button', { name: 'Confirm merge?' });
      // Armed from the keyboard, so focus-visible pauses the countdown.
      await merge.focus();
      await page.keyboard.press('Enter');
      await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
      // Tab inside the group is focus leaving one button for another in it.
      await page.keyboard.press('Tab');
      await expect(row.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await page.clock.runFor(9000);
      await expect(confirm).toBeVisible();
      // And a touch press on the hint, with focus blurred by it.
      await touchDown(row.locator('.confirm-hint'));
      await page.clock.runFor(9000);
      await expect(confirm).toBeVisible();
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

    test('a reaction list hides when focus leaves its pill', async ({
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
      // Shift+Tab leaves the pill for something that is not a pill.
      await page.keyboard.press('Shift+Tab');
      await expect(list).toHaveCount(0);
    });

    for (const armed of [false, true]) {
      test(`a success toast keeps waiting while a finger presses its text${armed ? ', from an armed row' : ''}`, async ({
        page,
      }) => {
        await page.route('**/api/v1/settings/bot-pr-updates', (route: Route) =>
          route.fulfill({ json: { allowBotPrUpdates: false } }),
        );
        await page.route(
          '**/api/v1/pull-requests/update-branch',
          (route: Route) => route.fulfill({ status: 202 }),
        );
        await open(page, [
          pr(2, {
            behind: true,
            ci: 'failure',
            mergeStatus: 'blocked',
            allowedActions: undefined,
            // Armed, Update branch is the waiting chip's label (#4971).
            ...(armed && {
              ci: 'pending',
              mergeStatus: 'mergeable',
              autoMergeEnabled: true,
              autoMerge: {
                state: 'waiting',
                code: 'checks_pending',
                message: 'Auto-merge is waiting for the checks to finish.',
              },
              allowedActions: [
                { action: 'close' },
                { action: 'update_branch' },
                { action: 'cancel_auto_merge' },
              ],
            }),
          }),
        ]);
        await page
          .locator('#pr-rows .row')
          .first()
          .getByRole('button', {
            name: armed ? 'Auto-merge on, update branch' : 'Update branch',
          })
          .click();
        const toast = page.locator('#feedback-toasts .feedback-toast').first();
        await expect(toast).toContainText('Branch update requested.');
        await toast.getByRole('button', { name: 'Show row' }).focus();
        await touchDown(toast.getByText('Branch update requested.'));
        // Well inside the 6s life, so only a handler that ends the toast shows.
        await page.clock.runFor(1000);
        await expect(toast).toBeVisible();
      });
    }
  });
}
