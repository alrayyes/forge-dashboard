import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { pickedValues, pickOnly } from './label-filter-helper';
import { test } from './server-fixture';
import { settle } from './settle-helper';

// #714: per-pull-request action feedback lives on the row (an inline
// status line), in a bottom-right toast stack, and in an Activity panel.
// The top banner is left for global conditions.

interface MockUpdateRequest {
  phase: 'queued';
  requestedAt: string;
  expiresAt: string;
}

interface MockPR {
  updateRequest?: MockUpdateRequest;
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  ci: string;
  labels: { name: string; color: string }[];
  createdAt: string;
  updatedAt: string;
  mergeStatus: string;
  behind: boolean;
}

function makePR(number: number, overrides: Partial<MockPR> = {}): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Pull request ${number}`,
    url: `https://example.com/${number}`,
    author: 'claude',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    ...overrides,
  };
}

function snapshot(prs: MockPR[]) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: prs,
    issues: [],
  };
}

const toasts = (page: Page) => page.locator('#feedback-toasts .feedback-toast');
const rowFor = (page: Page, n: number) =>
  page.locator('#pr-rows .row', {
    hasText: new RegExp(`Pull request ${n}(?!\\d)`),
  });

interface Mocks {
  hits: Record<number, number>;
  // PR numbers whose update-branch call should fail.
  failing: Set<number>;
  // What the dashboard serves now: the server records an accepted update
  // on the pull request until a fetch shows it landed (#982).
  served: () => MockPR[];
}

// Serves the given pull requests (which stay behind, so a queued branch
// update keeps waiting) and an update-branch endpoint that answers after
// `delayMs`.
async function setup(
  page: Page,
  prs: MockPR[],
  opts: { delayMs?: number; failing?: number[]; fakeClock?: boolean } = {},
): Promise<Mocks> {
  const recorded = new Set<number>();
  const served = () =>
    prs.map((pr) =>
      recorded.has(pr.number)
        ? {
            ...pr,
            updateRequest: {
              phase: 'queued' as const,
              requestedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            },
          }
        : pr,
    );
  const mocks: Mocks = {
    hits: {},
    failing: new Set(opts.failing ?? []),
    served,
  };
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
      body: JSON.stringify(snapshot(served())),
    }),
  );
  await page.route('**/api/v1/dashboard/refresh', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(served())),
    }),
  );
  await page.route(
    '**/api/v1/pull-requests/update-branch',
    async (route: Route) => {
      const body = route.request().postDataJSON() as { number: number };
      mocks.hits[body.number] = (mocks.hits[body.number] ?? 0) + 1;
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 200));
      if (mocks.failing.has(body.number))
        return route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'github: PUT /x: upstream broke',
            message: 'upstream broke',
          }),
        });
      recorded.add(body.number);
      return route.fulfill({ status: 202 });
    },
  );
  // Installed before the reload so the page's timers run on the fake clock; a
  // test then moves time with page.clock.runFor instead of sleeping (#1378).
  // Don't combine this with a spec's own Date.now script (addInitScript): the
  // order they install in would matter.
  if (opts.fakeClock) await page.clock.install();
  await page.goto('/pull-requests.html');
  return mocks;
}

async function updateBranch(row: Locator) {
  await row.getByRole('button', { name: 'Update branch' }).click();
}

test.describe('inline feedback, toasts and the activity panel', () => {
  test('two pull requests in flight each show their own waiting chip', async ({
    page,
  }) => {
    await setup(page, [makePR(1), makePR(2)], { delayMs: 1500 });
    await updateBranch(rowFor(page, 1));
    await updateBranch(rowFor(page, 2));

    for (const n of [1, 2]) {
      const chip = rowFor(page, n).locator('.wait-chip');
      await expect(chip.locator('.wait-chip-label')).toHaveText(
        'Updating branch',
      );
      await expect(chip).toContainText(/next refresh in \d+s/i);
    }
    // The top banner is not used for per-pull-request actions.
    await expect(page.locator('#status-banner')).toHaveCount(0);
    await expect(page.locator('#error-banner')).toHaveCount(0);
    await expect(page.locator('#activity-toggle')).toContainText('Activity 2');
  });

  test('the chip shows a countdown outside the announced text, then Refreshing…', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __skew: number };
      w.__skew = 0;
      const real = Date.now.bind(Date);
      Date.now = () => real() + w.__skew;
    });
    await setup(page, [makePR(1)]);
    await updateBranch(rowFor(page, 1));

    const countdown = rowFor(page, 1).locator('.feedback-countdown');
    await expect(countdown).toHaveText(/next refresh in \d+s/i);
    await expect(countdown).toHaveAttribute('aria-hidden', 'true');

    await page.evaluate(() => {
      (window as unknown as { __skew: number }).__skew = 60_000;
    });
    await expect(countdown).toHaveText(/Refreshing…/);
  });

  test('a queued request raises a success toast with the reference, message, Show row and dismiss', async ({
    page,
  }) => {
    await setup(page, [makePR(7)]);
    await updateBranch(rowFor(page, 7));

    const toast = toasts(page).first();
    await expect(toast).toContainText('alrayyes/forge-dashboard#7');
    await expect(toast).toContainText('Branch update requested.');
    await expect(toast.getByRole('button', { name: 'Show row' })).toBeVisible();
    await toast.getByRole('button', { name: /Dismiss/ }).click();
    await expect(toasts(page)).toHaveCount(0);
    // Dismissing the toast leaves the row's own chip and the activity entry.
    await expect(rowFor(page, 7).locator('.wait-chip-label')).toHaveText(
      'Updating branch',
    );
    await expect(page.locator('#activity-toggle')).toContainText('Activity 1');
  });

  test('a success toast dismisses itself after about 6 seconds, and holds while hovered', async ({
    page,
  }) => {
    await setup(page, [makePR(1)], { fakeClock: true });
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await expect(toast).toBeVisible();
    await toast.hover();
    await page.clock.runFor(7500);
    await expect(toast).toBeVisible();

    await page.mouse.move(5, 5);
    // Still there after 4.5 s, so it doesn't vanish early, and gone by 7 s.
    await page.clock.runFor(4500);
    await expect(toast).toBeVisible();
    await page.clock.runFor(2500);
    await expect(toast).toBeHidden();
  });

  test('a success toast holds while focus is inside it', async ({ page }) => {
    await setup(page, [makePR(1)], { fakeClock: true });
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await toast.getByRole('button', { name: 'Show row' }).focus();
    // Focus moved by Show row would scroll; this only focuses the link.
    await page.clock.runFor(7500);
    await expect(toast).toBeVisible();
  });

  test('an error toast stays until it is dismissed, and the row then shows a Failed line with Retry', async ({
    page,
  }) => {
    const mocks = await setup(page, [makePR(3)], {
      failing: [3],
      fakeClock: true,
    });
    await updateBranch(rowFor(page, 3));

    const toast = toasts(page).first();
    await expect(toast).toContainText('alrayyes/forge-dashboard#3');
    await expect(toast).toContainText('upstream broke');
    await page.clock.runFor(7500);
    await expect(toast).toBeVisible();

    // The toast says it, so the row doesn't repeat it (#3914) ...
    const line = rowFor(page, 3).locator('.row-feedback');
    await expect(line).toBeHidden();

    // ... until the toast is dismissed.
    await toast.getByRole('button', { name: /Dismiss/ }).click();
    await expect(toasts(page)).toHaveCount(0);
    await expect(line).toContainText('Failed');
    await expect(line).toContainText('upstream broke');

    await line.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => mocks.hits[3]).toBe(2);

    // The mock fails every attempt, so the retry raises its own error toast.
    await expect(toasts(page)).toHaveCount(1);
    await toasts(page)
      .first()
      .getByRole('button', { name: /Dismiss/ })
      .click();
    await expect(toasts(page)).toHaveCount(0);
  });

  test('at most three toasts show, newest first; the rest stay in Activity', async ({
    page,
  }) => {
    await setup(page, [makePR(1), makePR(2), makePR(3), makePR(4)], {
      failing: [1, 2, 3, 4],
    });
    for (const n of [1, 2, 3, 4]) {
      await updateBranch(rowFor(page, n));
      await expect(rowFor(page, n).locator('.row-feedback')).toContainText(
        'Failed',
      );
    }
    await expect(toasts(page)).toHaveCount(3);
    await expect(toasts(page).nth(0)).toContainText('#4');
    await expect(toasts(page).nth(1)).toContainText('#3');
    await expect(toasts(page).nth(2)).toContainText('#2');
    await expect(page.locator('#activity-toggle')).toContainText('Activity 4');

    // Dismissing one lets the hidden one in.
    await toasts(page)
      .first()
      .getByRole('button', { name: /Dismiss/ })
      .click();
    await expect(toasts(page)).toHaveCount(3);
    await expect(toasts(page).nth(2)).toContainText('#1');
  });

  test('Show row scrolls to the row and focuses it', async ({ page }) => {
    const prs = Array.from({ length: 12 }, (_, i) => makePR(i + 1));
    await page.setViewportSize({ width: 1280, height: 500 });
    await setup(page, prs);
    const target = rowFor(page, 2);
    await updateBranch(target);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(target).not.toBeInViewport();

    await toasts(page)
      .first()
      .getByRole('button', { name: 'Show row' })
      .click();
    await expect(target).toBeInViewport();
    await expect(target).toBeFocused();
  });

  test('Show row moves the list to the page the row is on (#723)', async ({
    page,
  }) => {
    const prs = Array.from({ length: 30 }, (_, i) =>
      makePR(i + 1, {
        updatedAt: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
    await setup(page, prs);
    await updateBranch(rowFor(page, 1));
    await page.getByRole('button', { name: '2', exact: true }).click();
    await expect(rowFor(page, 1)).toHaveCount(0);

    await toasts(page)
      .first()
      .getByRole('button', { name: 'Show row' })
      .click();

    await expect(rowFor(page, 1)).toBeFocused();
    await expect(page.locator('#feedback-live')).toContainText(
      'Moved to page 1',
    );
  });

  test('Show row says so when the pull request is merged or closed (#723)', async ({
    page,
  }) => {
    const prs = [makePR(1), makePR(2)];
    await setup(page, prs);
    await updateBranch(rowFor(page, 2));
    await page.route('**/api/v1/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot([prs[0]])),
      }),
    );
    await page.click('#force-refresh-button');
    await expect(rowFor(page, 2)).toHaveCount(0);

    await page.locator('#activity-toggle').click();
    await page
      .locator('#activity-panel .activity-item')
      .first()
      .getByRole('button', { name: 'Show row' })
      .click();

    await expect(page.locator('#feedback-live')).toContainText(
      'merged or closed',
    );
  });

  test('the Activity panel lists every action with its state, Show row, and Clear finished', async ({
    page,
  }) => {
    await setup(page, [makePR(1), makePR(2)], { failing: [2] });
    await updateBranch(rowFor(page, 1));
    await updateBranch(rowFor(page, 2));
    await expect(rowFor(page, 2).locator('.row-feedback')).toContainText(
      'Failed',
    );

    const toggle = page.locator('#activity-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const panel = page.locator('#activity-panel');
    await expect(panel).toBeVisible();
    const items = panel.locator('.activity-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('alrayyes/forge-dashboard#2');
    await expect(items.nth(0)).toContainText('Failed');
    await expect(items.nth(1)).toContainText('alrayyes/forge-dashboard#1');
    await expect(items.nth(1)).toContainText('Queued');
    await expect(
      items.nth(0).getByRole('button', { name: 'Show row' }),
    ).toBeVisible();

    await panel.getByRole('button', { name: 'Clear finished' }).click();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('#1');
    await expect(toggle).toContainText('Activity 1');
    // The failed row's inline line goes with it; the queued one stays.
    await expect(rowFor(page, 2).locator('.row-feedback')).toHaveCount(0);
    await expect(rowFor(page, 1).locator('.wait-chip-label')).toHaveText(
      'Updating branch',
    );

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('the activity control is sticky while the page scrolls', async ({
    page,
  }) => {
    const prs = Array.from({ length: 15 }, (_, i) => makePR(i + 1));
    await page.setViewportSize({ width: 1280, height: 500 });
    await setup(page, prs);
    await updateBranch(rowFor(page, 1));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('#activity-toggle')).toBeInViewport();
  });

  test('one polite live region announces each event once, never the countdown', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __live: string[] };
      w.__live = [];
      document.addEventListener('DOMContentLoaded', () => {
        const live = document.getElementById('feedback-live');
        if (!live) return;
        new MutationObserver(() => {
          if (live.textContent) w.__live.push(live.textContent);
        }).observe(live, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
    });
    await setup(page, [makePR(5)], { fakeClock: true });
    await expect(page.locator('#feedback-live')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    // Exactly one live region carries the feedback; toasts and the panel
    // are not live themselves, or each message would be read twice.
    await expect(page.locator('#feedback-toasts [aria-live]')).toHaveCount(0);
    await expect(page.locator('#activity-panel [aria-live]')).toHaveCount(0);
    await expect(page.locator('#feedback-toasts[aria-live]')).toHaveCount(0);

    await updateBranch(rowFor(page, 5));
    await expect(toasts(page)).toHaveCount(1);
    // Long enough for the countdown to tick, which must never be announced.
    await page.clock.runFor(3500);

    const spoken = await page.evaluate(
      () => (window as unknown as { __live: string[] }).__live,
    );
    const mentions = spoken.filter((s) =>
      s.includes('Branch update requested'),
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toContain('alrayyes/forge-dashboard#5');
    for (const s of spoken) expect(s).not.toMatch(/\d+s\b/);
  });

  test('inline lines, toasts and the activity list survive a snapshot and a forced refresh', async ({
    page,
  }) => {
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
    const prs = [makePR(1), makePR(2)];
    const mocks = await setup(page, prs, { failing: [2] });
    await updateBranch(rowFor(page, 1));
    await updateBranch(rowFor(page, 2));
    await expect(rowFor(page, 2).locator('.row-feedback')).toContainText(
      'Failed',
    );

    await page.evaluate(
      (data) => {
        const w = window as unknown as { __streams: EventSource[] };
        for (const stream of w.__streams)
          stream.onmessage?.(new MessageEvent('message', { data }));
      },
      JSON.stringify(snapshot(mocks.served())),
    );
    const answered = page.waitForResponse('**/api/v1/dashboard/refresh');
    await page.click('#force-refresh-button');
    await answered;
    await settle(page);

    await expect(rowFor(page, 1).locator('.wait-chip-label')).toHaveText(
      'Updating branch',
    );
    await expect(rowFor(page, 2).locator('.row-feedback')).toContainText(
      'Failed',
    );
    await expect(toasts(page).first()).toContainText('upstream broke');
    await expect(page.locator('#activity-toggle')).toContainText('Activity 2');
  });

  test('a snapshot that shows the update landed finishes the entry with a toast', async ({
    page,
  }) => {
    const pr = makePR(9);
    await setup(page, [pr]);
    await updateBranch(rowFor(page, 9));
    await expect(rowFor(page, 9).locator('.wait-chip-label')).toHaveText(
      'Updating branch',
    );

    await page.route('**/api/v1/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot([{ ...pr, behind: false }])),
      }),
    );
    await page.click('#force-refresh-button');

    await expect(rowFor(page, 9).locator('.wait-chip-label')).toHaveText(
      'Settled',
    );
    await expect(rowFor(page, 9).locator('.row-feedback')).toHaveCount(0);
    await expect(toasts(page).first()).toContainText('Branch updated.');
    await page.locator('#activity-toggle').click();
    await expect(
      page.locator('#activity-panel .activity-item').first(),
    ).toContainText('Done');
  });

  test('the banner still reports a global condition', async ({ page }) => {
    await setup(page, [makePR(1)]);
    await page.route('**/api/v1/dashboard*', (route: Route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'down' }),
      }),
    );
    await page.goto('/pull-requests.html');
    await expect(page.locator('#error-banner')).toContainText(
      'The backend answered with an error (500)',
    );
  });

  test('with prefers-reduced-motion, toasts appear without animation', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page, [makePR(1)]);
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCSS('animation-name', 'none');
    await expect(toast).toHaveCSS('transition-duration', /^0s(, 0s)*$/);
  });

  // Playwright has no touch drag, so the gesture is sent as the pointer events
  // a finger makes (#4020). Each step moves the pointer to `dx` from the start.
  async function touchDrag(
    toast: Locator,
    steps: number[],
    release: 'up' | 'cancel' | 'hold' = 'up',
    pointerType: 'touch' | 'pen' | 'mouse' = 'touch',
  ) {
    // Resolves to whether the toast is still in the page the moment the
    // gesture ends, before any slide-out has had time to finish.
    return toast.evaluate(
      (el, args) => {
        const box = el.getBoundingClientRect();
        const init = (x: number, type: string) =>
          new PointerEvent(type, {
            pointerId: 7,
            pointerType: args.pointerType,
            isPrimary: true,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: box.top + box.height / 2,
          });
        const x0 = box.left + box.width / 2;
        el.dispatchEvent(init(x0, 'pointerdown'));
        for (const dx of args.steps)
          el.dispatchEvent(init(x0 + dx * box.width, 'pointermove'));
        const last = x0 + (args.steps.at(-1) ?? 0) * box.width;
        if (args.release === 'up') el.dispatchEvent(init(last, 'pointerup'));
        if (args.release === 'cancel')
          el.dispatchEvent(init(last, 'pointercancel'));
        return el.isConnected;
      },
      { steps, release, pointerType },
    );
  }

  for (const [name, dx] of [
    ['left', -0.5],
    ['right', 0.5],
  ] as const) {
    test(`swiping a toast past a third of its width ${name} removes it`, async ({
      page,
    }) => {
      await setup(page, [makePR(1)]);
      await updateBranch(rowFor(page, 1));
      const toast = toasts(page).first();
      await expect(toast).toBeVisible();
      await touchDrag(toast, [dx / 2, dx]);
      await expect(toasts(page)).toHaveCount(0);
    });
  }

  test('a shorter swipe springs the toast back and it stays', async ({
    page,
  }) => {
    await setup(page, [makePR(1)]);
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await touchDrag(toast, [0.1, 0.2]);
    await expect(toasts(page)).toHaveCount(1);
    await expect(toast).toHaveCSS('transform', 'none');
  });

  test('the close button still dismisses a toast that has been swiped back', async ({
    page,
  }) => {
    await setup(page, [makePR(1)]);
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await touchDrag(toast, [0.2]);
    await toast.getByRole('button', { name: /^Dismiss/ }).click();
    await expect(toasts(page)).toHaveCount(0);
  });

  test('holding a toast mid-drag pauses its timer, and letting go resumes it', async ({
    page,
  }) => {
    await setup(page, [makePR(1)], { fakeClock: true });
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await expect(toast).toBeVisible();
    await touchDrag(toast, [0.2], 'hold');
    await page.clock.runFor(12_000);
    await expect(toast).toBeVisible();

    await toast.evaluate((el) =>
      el.dispatchEvent(
        new PointerEvent('pointercancel', {
          pointerId: 7,
          pointerType: 'touch',
          bubbles: true,
        }),
      ),
    );
    await page.clock.runFor(7500);
    await expect(toast).toBeHidden();
  });

  test('a toast opts out of sideways panning in the browser (touch-action)', async ({
    page,
  }) => {
    await setup(page, [makePR(1)]);
    await updateBranch(rowFor(page, 1));
    await expect(toasts(page).first()).toHaveCSS('touch-action', 'pan-y');
  });

  test('a mouse drag neither moves nor dismisses a toast, a pen swipe dismisses', async ({
    page,
  }) => {
    await setup(page, [makePR(1), makePR(2)]);
    await updateBranch(rowFor(page, 1));
    await updateBranch(rowFor(page, 2));
    await expect(toasts(page)).toHaveCount(2);
    const toast = toasts(page).first();
    await touchDrag(toast, [0.25, 0.5], 'hold', 'mouse');
    await expect(toast).toHaveCSS('transform', 'none');
    await touchDrag(toast, [0.5], 'up', 'mouse');
    await expect(toasts(page)).toHaveCount(2);
    await touchDrag(toast, [0.5], 'up', 'pen');
    await expect(toasts(page)).toHaveCount(1);
  });

  test('a cancelled gesture past the threshold springs back, it does not dismiss', async ({
    page,
  }) => {
    await setup(page, [makePR(1)]);
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await touchDrag(toast, [0.25, 0.5], 'hold');
    await expect(toast).not.toHaveCSS('transform', 'none');
    await toast.evaluate((el) =>
      el.dispatchEvent(
        new PointerEvent('pointercancel', {
          pointerId: 7,
          pointerType: 'touch',
          bubbles: true,
        }),
      ),
    );
    await expect(toast).toHaveCSS('transform', 'none');
    await expect(toasts(page)).toHaveCount(1);
  });

  test('a spring-back after a short swipe resumes the auto-dismiss timer', async ({
    page,
  }) => {
    await setup(page, [makePR(1)], { fakeClock: true });
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await expect(toast).toBeVisible();
    await touchDrag(toast, [0.1, 0.2]);
    await expect(toast).toHaveCSS('transform', 'none');
    await page.clock.runFor(7500);
    await expect(toast).toBeHidden();
  });

  test('hover or focus ending mid-drag does not restart the paused timer', async ({
    page,
  }) => {
    await setup(page, [makePR(1)], { fakeClock: true });
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await expect(toast).toBeVisible();
    await touchDrag(toast, [0.2], 'hold');
    await toast.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('mouseleave'));
      el.dispatchEvent(new FocusEvent('focusout'));
    });
    await page.clock.runFor(12_000);
    await expect(toast).toBeVisible();
  });

  test('an error toast, which has no timer, can be swiped away too', async ({
    page,
  }) => {
    await setup(page, [makePR(2)], { failing: [2] });
    await updateBranch(rowFor(page, 2));
    const toast = toasts(page).first();
    await expect(toast).toHaveAttribute('data-kind', 'error');
    await touchDrag(toast, [0.5]);
    await expect(toasts(page)).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`a swipe works at 390px and axe stays clean, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await setup(page, [makePR(1), makePR(2)]);
      await updateBranch(rowFor(page, 1));
      await updateBranch(rowFor(page, 2));
      await expect(toasts(page)).toHaveCount(2);
      const axe = () =>
        new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
      expect((await axe()).violations, 'before the swipe').toEqual([]);
      await touchDrag(toasts(page).first(), [0.25, 0.5]);
      await expect(toasts(page)).toHaveCount(1);
      expect((await axe()).violations, 'after the swipe').toEqual([]);
    });
  }

  test('a touch during the slide-out does not start a second gesture', async ({
    page,
  }) => {
    await setup(page, [makePR(1)]);
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await touchDrag(toast, [0.5]);
    const transform = await toast.evaluate((el) => {
      const ev = (type: string, x: number) =>
        new PointerEvent(type, {
          pointerId: 8,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          clientX: x,
        });
      const x0 = el.getBoundingClientRect().left;
      el.dispatchEvent(ev('pointerdown', x0));
      el.dispatchEvent(ev('pointermove', x0 + 30));
      return (el as HTMLElement).style.transform;
    });
    expect(transform).toContain('120%');
    await expect(toasts(page)).toHaveCount(0);
  });

  test('with prefers-reduced-motion, a swiped toast leaves without a slide', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page, [makePR(1), makePR(2)], { fakeClock: true });
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    // Gone in the same task as the gesture, not after a slide-out.
    expect(await touchDrag(toast, [0.5])).toBe(false);
    await expect(toasts(page)).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('has no axe violations with a toast and the panel open', async ({
    page,
  }) => {
    await setup(page, [makePR(1), makePR(2)], { failing: [2] });
    await updateBranch(rowFor(page, 1));
    await updateBranch(rowFor(page, 2));
    await expect(toasts(page)).toHaveCount(2);
    await page.locator('#activity-toggle').click();
    await expect(page.locator('#activity-panel')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('inline feedback and a saved filter', () => {
  test('Show row clears the filter that hides the row, says which, and focuses it (#723)', async ({
    page,
  }) => {
    await setup(page, [makePR(1), makePR(2, { author: 'alice' }), makePR(3)]);
    await updateBranch(rowFor(page, 2));
    await pickOnly(page, 'author', 'github:claude');
    await expect(rowFor(page, 2)).toHaveCount(0);

    await toasts(page)
      .first()
      .getByRole('button', { name: 'Show row' })
      .click();

    await expect.poll(() => pickedValues(page, 'author')).toEqual([]);
    await expect(rowFor(page, 2)).toBeFocused();
    await expect(page.locator('#feedback-live')).toContainText(
      'Cleared the Author filter',
    );
  });
});

test.describe('the Activity control is hidden when empty (#3684)', () => {
  const sizes = [
    { width: 360, height: 740 },
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ];

  test('no button and no row for it with nothing to show, then it appears with its count', async ({
    page,
  }) => {
    await setup(page, [makePR(1)]);
    await expect(rowFor(page, 1)).toBeVisible();
    await expect(page.locator('#activity-toggle')).toBeHidden();
    await expect(page.locator('.activity-bar')).toBeHidden();
    expect(
      await page
        .locator('.activity-bar')
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(0);

    await updateBranch(rowFor(page, 1));
    const toggle = page.locator('#activity-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Activity 1');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', 'activity-panel');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#activity-panel')).toBeVisible();
  });

  test('Clear finished with nothing left closes the panel, hides the button and focuses Refresh', async ({
    page,
  }) => {
    await setup(page, [makePR(2)], { failing: [2] });
    await updateBranch(rowFor(page, 2));
    await expect(rowFor(page, 2).locator('.row-feedback')).toContainText(
      'Failed',
    );
    await page.locator('#activity-toggle').click();
    const panel = page.locator('#activity-panel');
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: 'Clear finished' }).click();

    await expect(panel).toBeHidden();
    await expect(page.locator('#activity-toggle')).toBeHidden();
    await expect(page.locator('#force-refresh-button')).toBeFocused();
  });

  test('a count change keeps focus on the button and is announced politely', async ({
    page,
  }) => {
    await setup(page, [makePR(1), makePR(2)]);
    await updateBranch(rowFor(page, 1));
    const toggle = page.locator('#activity-toggle');
    await toggle.focus();
    // A script click, so the pointer doesn't move focus off the button.
    await rowFor(page, 2)
      .getByRole('button', { name: 'Update branch' })
      .evaluate((el: HTMLElement) => el.click());
    await expect(toggle).toContainText('Activity 2');
    await expect(toggle).toBeFocused();
    await expect(page.locator('#feedback-live')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    await expect(page.locator('#feedback-live')).not.toBeEmpty();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe violations while hidden and shown, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await setup(page, [makePR(1)]);
      await expect(rowFor(page, 1)).toBeVisible();
      for (const phase of ['hidden', 'shown']) {
        if (phase === 'shown') {
          await updateBranch(rowFor(page, 1));
          await expect(page.locator('#activity-toggle')).toBeVisible();
        }
        for (const size of sizes) {
          await page.setViewportSize(size);
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          expect(results.violations, `${phase} at ${size.width}px`).toEqual([]);
        }
      }
    });
  }
});
