import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #714: per-pull-request action feedback lives on the row (an inline
// status line), in a bottom-right toast stack, and in an Activity panel.
// The top banner is left for global conditions.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `inline-feedback-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Feedback User');
}

interface MockPR {
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
  page.locator('#pr-rows .row', { hasText: `Pull request ${n}` });

interface Mocks {
  hits: Record<number, number>;
  // PR numbers whose update-branch call should fail.
  failing: Set<number>;
}

// Serves the given pull requests (which stay behind, so a queued branch
// update keeps waiting) and an update-branch endpoint that answers after
// `delayMs`.
async function setup(
  page: Page,
  prs: MockPR[],
  opts: { delayMs?: number; failing?: number[] } = {},
): Promise<Mocks> {
  const mocks: Mocks = { hits: {}, failing: new Set(opts.failing ?? []) };
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
  await page.route('**/api/dashboard/refresh', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(prs)),
    }),
  );
  await page.route(
    '**/api/pull-requests/update-branch',
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
      return route.fulfill({ status: 202 });
    },
  );
  await page.reload();
  return mocks;
}

async function updateBranch(row: Locator) {
  await row.getByRole('button', { name: 'Update branch' }).click();
}

test.describe('inline feedback, toasts and the activity panel', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
  });

  test('two pull requests in flight each show their own inline status line', async ({
    page,
  }) => {
    await setup(page, [makePR(1), makePR(2)], { delayMs: 1500 });
    await updateBranch(rowFor(page, 1));
    await updateBranch(rowFor(page, 2));

    for (const n of [1, 2]) {
      const line = rowFor(page, n).locator('.row-feedback');
      await expect(line).toContainText('Queued');
      await expect(line).toContainText('Awaiting the next refresh');
    }
    // The top banner is not used for per-pull-request actions.
    await expect(page.locator('#status-banner')).toHaveCount(0);
    await expect(page.locator('#error-banner')).toHaveCount(0);
    await expect(page.locator('#activity-toggle')).toContainText('Activity 2');
  });

  test('the inline line shows a countdown outside the announced text, then Refreshing…', async ({
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
    await expect(countdown).toHaveText(/next refresh in \d+s/);
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
    // Dismissing the toast leaves the row's own line and the activity entry.
    await expect(rowFor(page, 7).locator('.row-feedback')).toContainText(
      'Queued',
    );
    await expect(page.locator('#activity-toggle')).toContainText('Activity 1');
  });

  test('a success toast dismisses itself after about 6 seconds, and holds while hovered', async ({
    page,
  }) => {
    await setup(page, [makePR(1)]);
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await expect(toast).toBeVisible();
    await toast.hover();
    await page.waitForTimeout(7500);
    await expect(toast).toBeVisible();

    await page.mouse.move(5, 5);
    await expect(toast).toBeHidden({ timeout: 9000 });
  });

  test('a success toast holds while focus is inside it', async ({ page }) => {
    await setup(page, [makePR(1)]);
    await updateBranch(rowFor(page, 1));
    const toast = toasts(page).first();
    await toast.getByRole('button', { name: 'Show row' }).focus();
    // Focus moved by Show row would scroll; this only focuses the link.
    await page.waitForTimeout(7500);
    await expect(toast).toBeVisible();
  });

  test('an error toast stays until it is dismissed, and the row keeps a Failed line with Retry', async ({
    page,
  }) => {
    const mocks = await setup(page, [makePR(3)], { failing: [3] });
    await updateBranch(rowFor(page, 3));

    const toast = toasts(page).first();
    await expect(toast).toContainText('alrayyes/forge-dashboard#3');
    await expect(toast).toContainText('upstream broke');
    await page.waitForTimeout(7500);
    await expect(toast).toBeVisible();

    const line = rowFor(page, 3).locator('.row-feedback');
    await expect(line).toContainText('Failed');
    await expect(line).toContainText('upstream broke');

    await line.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => mocks.hits[3]).toBe(2);

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
    await expect(rowFor(page, 1).locator('.row-feedback')).toContainText(
      'Queued',
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
    await setup(page, [makePR(5)]);
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
    await page.waitForTimeout(3500);

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
    await setup(page, prs, { failing: [2] });
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
      JSON.stringify(snapshot(prs)),
    );
    await page.click('#force-refresh-button');
    await page.waitForTimeout(500);

    await expect(rowFor(page, 1).locator('.row-feedback')).toContainText(
      'Queued',
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
    await expect(rowFor(page, 9).locator('.row-feedback')).toContainText(
      'Queued',
    );

    await page.route('**/api/dashboard/refresh', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot([{ ...pr, behind: false }])),
      }),
    );
    await page.click('#force-refresh-button');

    await expect(rowFor(page, 9).locator('.row-feedback')).toHaveCount(0);
    await expect(toasts(page).first()).toContainText('Branch updated.');
    await page.locator('#activity-toggle').click();
    await expect(
      page.locator('#activity-panel .activity-item').first(),
    ).toContainText('Done');
  });

  test('the banner still reports a global condition', async ({ page }) => {
    await setup(page, [makePR(1)]);
    await page.route('**/api/dashboard*', (route: Route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'down' }),
      }),
    );
    await page.reload();
    await expect(page.locator('#error-banner')).toContainText(
      'Could not reach the backend',
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
    const motion = await toast.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        animation: style.animationName,
        transition: style.transitionDuration,
      };
    });
    expect(motion.animation).toBe('none');
    expect(motion.transition).toMatch(/^0s(, 0s)*$/);
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
