import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #1082: Dependabot reacts to an `@dependabot rebase` comment with a
// thumbs-up to say it got the command. The server looks for that reaction and
// puts `acknowledgedAt` on the pull request's botRequest; the row says so, and
// says plainly when nothing has come back after the wait. These tests play the
// server by putting the fields on the mocked snapshots, as bot-rebase-pickup
// does.

const COMMENT_URL =
  'https://github.com/alrayyes/forge-dashboard/pull/42#issuecomment-1001';

interface MockBotRequest {
  bot: string;
  action: string;
  phase: 'queued' | 'rebasing' | 'expired';
  requestedAt: string;
  expiresAt: string;
  acknowledgedAt?: string;
  commentUrl?: string;
}

function dependabotRequest(
  phase: MockBotRequest['phase'],
  extra: Partial<MockBotRequest> = {},
  requestedAgoMs = 0,
): MockBotRequest {
  const requestedAt = Date.now() - requestedAgoMs;
  return {
    bot: 'dependabot',
    action: 'rebase',
    phase,
    requestedAt: new Date(requestedAt).toISOString(),
    expiresAt: new Date(requestedAt + 10 * 60_000).toISOString(),
    ...extra,
  };
}

function makePR(botRequest?: MockBotRequest) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Bump a dependency',
    url: 'https://github.com/alrayyes/forge-dashboard/pull/42',
    author: 'dependabot',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeStatus: 'blocked',
    behind: true,
    botRequest,
  };
}

function snapshot(pr: ReturnType<typeof makePR>) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: pr.forge, reachable: true, repoCount: 1 }],
    pullRequests: [pr],
    issues: [],
  };
}

const row = (page: Page) => page.locator('#pr-rows .row').first();
const line = (page: Page) => row(page).locator('.row-feedback');

test.describe('Dependabot acknowledgment (#1082)', () => {
  let current: ReturnType<typeof makePR>;
  let posts = 0;

  test.beforeEach(async ({ page, request, baseURL }) => {
    current = makePR();
    posts = 0;
    const username = `dependabot-ack-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await registerViaInvite(
      page,
      request as APIRequestContext,
      baseURL,
      username,
      'Dependabot Ack User',
    );
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
    await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowBotPrUpdates: false }),
      }),
    );
    const answer = (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(current)),
      });
    await page.route('**/api/dashboard*', answer);
    await page.route('**/api/dashboard/refresh', answer);
    await page.route('**/api/pull-requests/dependabot-action', (route) => {
      posts++;
      current = { ...current, botRequest: dependabotRequest('queued') };
      return route.fulfill({ status: 204 });
    });
    await page.reload();
  });

  async function request(page: Page) {
    await row(page).getByRole('button', { name: 'Dependabot: Rebase' }).click();
    await expect(
      row(page).getByRole('button', { name: 'Rebase requested' }),
    ).toBeDisabled();
    // The server has answered 204, so nothing later overwrites the live region.
    await expect(page.locator('#feedback-toasts')).toContainText(
      'rebase requested.',
    );
  }

  async function push(page: Page, pr: ReturnType<typeof makePR>) {
    await page.evaluate(
      (data) => {
        const w = window as unknown as { __streams: EventSource[] };
        for (const stream of w.__streams)
          stream.onmessage?.(new MessageEvent('message', { data }));
      },
      JSON.stringify(snapshot(pr)),
    );
  }

  async function expectNoViolations(page: Page) {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  }

  test('before Dependabot reacts the row only says it was requested', async ({
    page,
  }) => {
    await request(page);

    await expect(line(page)).toContainText(
      'Dependabot will pick this up shortly.',
    );
    await expect(line(page)).not.toContainText('acknowledged');
  });

  test('a thumbs-up from Dependabot shows as acknowledged, in words, and is announced once', async ({
    page,
  }) => {
    await request(page);
    current = {
      ...current,
      botRequest: dependabotRequest('queued', {
        acknowledgedAt: new Date().toISOString(),
        commentUrl: COMMENT_URL,
      }),
    };
    await push(page, current);

    await expect(line(page)).toContainText(
      'Dependabot acknowledged your rebase.',
    );
    await expect(line(page)).toContainText(
      'Waiting for it to push the rebased commit.',
    );
    await expect(line(page)).not.toContainText('will pick this up shortly');
    // The thumbs-up is decoration: the words carry the meaning.
    await expect(line(page).locator('.feedback-ack-icon')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await expect(page.locator('#feedback-live')).toContainText(
      'Dependabot acknowledged your rebase.',
    );
    await expect(
      row(page).getByRole('button', { name: 'Rebase requested' }),
    ).toBeDisabled();
    await expectNoViolations(page);

    // The same record on the next snapshot changes nothing and says nothing.
    await page.evaluate(() => {
      const live = document.getElementById('feedback-live');
      if (live) live.textContent = '';
    });
    await push(page, current);
    await page.waitForTimeout(500);
    await expect(page.locator('#feedback-live')).toHaveText('');
  });

  test('a reload while acknowledged still shows it', async ({ page }) => {
    current = {
      ...current,
      botRequest: dependabotRequest(
        'queued',
        { acknowledgedAt: new Date().toISOString(), commentUrl: COMMENT_URL },
        90_000,
      ),
    };
    await page.reload();

    await expect(line(page)).toContainText(
      'Dependabot acknowledged your rebase.',
    );
  });

  test('no reply after the wait says so, with Ask again and a link to the comment', async ({
    page,
  }) => {
    await request(page);
    current = {
      ...current,
      botRequest: dependabotRequest(
        'expired',
        { commentUrl: COMMENT_URL },
        11 * 60_000,
      ),
    };
    await push(page, current);

    await expect(line(page)).toContainText('No reply from Dependabot yet');
    await expect(
      line(page).getByRole('button', { name: /^Ask again/ }),
    ).toBeVisible();
    await expect(
      line(page).getByRole('button', { name: /^Retry/ }),
    ).toHaveCount(0);
    const open = line(page).getByRole('link', { name: /^Open comment/ });
    await expect(open).toHaveAttribute('href', COMMENT_URL);
    await expectNoViolations(page);
  });

  test('Ask again sends the rebase command once more', async ({ page }) => {
    await request(page);
    current = {
      ...current,
      botRequest: dependabotRequest(
        'expired',
        { commentUrl: COMMENT_URL },
        11 * 60_000,
      ),
    };
    await push(page, current);

    // The toasts sit over the row's corner; clear them like a user would.
    const dismiss = page.getByRole('button', {
      name: /^Dismiss notification/,
    });
    while ((await dismiss.count()) > 0) await dismiss.first().click();
    await line(page)
      .getByRole('button', { name: /^Ask again/ })
      .click();

    await expect.poll(() => posts).toBe(2);
    await expect(line(page)).toContainText(
      'Dependabot will pick this up shortly.',
    );
  });

  test('no comment link is offered when the server has not found the comment', async ({
    page,
  }) => {
    await request(page);
    current = {
      ...current,
      botRequest: dependabotRequest('expired', {}, 11 * 60_000),
    };
    await push(page, current);

    await expect(line(page)).toContainText('No reply from Dependabot yet');
    await expect(
      line(page).getByRole('link', { name: /^Open comment/ }),
    ).toHaveCount(0);
  });
});
