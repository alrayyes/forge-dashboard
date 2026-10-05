import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';

// #982: the server owns an Update branch the forge accepted. Each pull
// request in a snapshot carries `updateRequest` (queued, or expired after
// five minutes still behind) until a later fetch shows the branch caught up,
// and the page only draws it. These tests play the server by putting that
// field on the mocked snapshots.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `update-request-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Update Request User',
  );
}

interface MockUpdateRequest {
  phase: 'queued' | 'expired';
  requestedAt: string;
  expiresAt: string;
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
  updateRequest?: MockUpdateRequest;
}

function updateRequest(
  phase: MockUpdateRequest['phase'],
  requestedAgoMs = 0,
): MockUpdateRequest {
  const requestedAt = Date.now() - requestedAgoMs;
  return {
    phase,
    requestedAt: new Date(requestedAt).toISOString(),
    expiresAt: new Date(requestedAt + 5 * 60_000).toISOString(),
  };
}

function makePR(overrides: Partial<MockPR> = {}): MockPR {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'A pull request',
    url: 'https://github.com/alrayyes/forge-dashboard/pull/42',
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

function snapshot(pr: MockPR) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: pr.forge, reachable: true, repoCount: 1 }],
    pullRequests: [pr],
    issues: [],
  };
}

const row = (page: Page) => page.locator('#pr-rows .row').first();
const line = (page: Page) => row(page).locator('.row-feedback');

test.describe('update branch request from the server', () => {
  // What the mocked dashboard currently answers with: a test changes it to
  // play the server.
  let current: MockPR;

  test.beforeEach(async ({ page, request, baseURL }) => {
    current = makePR();
    await registerAndSignIn(page, request, baseURL);
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
    const answer = (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(current)),
      });
    await page.route('**/api/dashboard*', answer);
    await page.route('**/api/dashboard/refresh', answer);
    // The server records the request before it answers 202, so every
    // snapshot after that carries it.
    await page.route('**/api/pull-requests/update-branch', (route: Route) => {
      current = { ...current, updateRequest: updateRequest('queued') };
      return route.fulfill({ status: 202 });
    });
    await page.reload();
  });

  async function click(page: Page) {
    await row(page).getByRole('button', { name: 'Update branch' }).click();
    await expect(
      row(page).getByRole('button', { name: 'Queued…' }),
    ).toBeDisabled();
    await expect(page.locator('#feedback-toasts')).toContainText(
      'Branch update requested.',
    );
  }

  async function push(page: Page, pr: MockPR) {
    await page.evaluate(
      (data) => {
        const w = window as unknown as { __streams: EventSource[] };
        for (const stream of w.__streams)
          stream.onmessage?.(new MessageEvent('message', { data }));
      },
      JSON.stringify(snapshot(pr)),
    );
  }

  test('a reload mid-wait still shows Queued', async ({ page }) => {
    await click(page);
    await page.reload();

    await expect(
      row(page).getByRole('button', { name: 'Queued…' }),
    ).toBeDisabled();
    await expect(
      row(page).getByRole('button', { name: 'Update branch' }),
    ).toHaveCount(0);
    await expect(line(page)).toContainText('Queued');
  });

  test('a request seen only in the snapshot starts the row state', async ({
    page,
  }) => {
    current = { ...current, updateRequest: updateRequest('queued', 30_000) };
    await page.reload();

    await expect(
      row(page).getByRole('button', { name: 'Queued…' }),
    ).toBeDisabled();
    await expect(line(page)).toContainText('Queued');
  });

  test('a queued record on the next snapshot keeps the row Queued', async ({
    page,
  }) => {
    await click(page);
    await push(page, current);
    await page.waitForTimeout(500);
    await expect(
      row(page).getByRole('button', { name: 'Queued…' }),
    ).toBeDisabled();
    await expect(page.locator('#feedback-toasts .feedback-toast')).toHaveCount(
      1,
    );
  });

  test('the row finishes once the record is gone and the pull request is no longer behind', async ({
    page,
  }) => {
    await click(page);
    current = { ...current, behind: false, updateRequest: undefined };
    await push(page, current);

    await expect(
      row(page).getByRole('button', { name: 'Queued…' }),
    ).toHaveCount(0);
    await expect(
      row(page).getByRole('button', { name: 'Update branch' }),
    ).toHaveCount(0);
    await expect(page.locator('#feedback-toasts')).toContainText(
      'Branch updated.',
    );
  });

  test('expired in the snapshot shows the timed-out line and a toast, once', async ({
    page,
  }) => {
    await click(page);
    current = {
      ...current,
      updateRequest: updateRequest('expired', 5 * 60_000),
    };
    await push(page, current);

    await expect(line(page)).toContainText('Timed out');
    await expect(
      line(page).getByRole('button', { name: 'Retry' }),
    ).toBeVisible();
    const toasts = page.locator(
      '#feedback-toasts .feedback-toast[data-kind="error"]',
    );
    await expect(toasts).toHaveCount(1);
    await expect(toasts).not.toContainText(/five minutes|5 minutes/i);
    await expect(
      row(page).getByRole('button', { name: 'Update branch' }),
    ).toBeEnabled();

    // The same expired record on the next snapshot says nothing new.
    await push(page, current);
    await page.waitForTimeout(500);
    await expect(toasts).toHaveCount(1);
    await expect(
      row(page).getByRole('button', { name: 'Update branch' }),
    ).toBeEnabled();
  });

  test('Retry on an expired request asks again', async ({ page }) => {
    await click(page);
    current = {
      ...current,
      updateRequest: updateRequest('expired', 5 * 60_000),
    };
    await push(page, current);
    await line(page).getByRole('button', { name: 'Retry' }).click();

    await expect(
      row(page).getByRole('button', { name: 'Queued…' }),
    ).toBeDisabled();
  });

  test('an expired record found after a reload is not drawn as queued', async ({
    page,
  }) => {
    current = {
      ...current,
      updateRequest: updateRequest('expired', 6 * 60_000),
    };
    await page.reload();

    await expect(
      row(page).getByRole('button', { name: 'Update branch' }),
    ).toBeEnabled();
    await expect(page.locator('#feedback-toasts .feedback-toast')).toHaveCount(
      0,
    );
  });

  // #691: a refresh that started before the click can't tell the click
  // happened, so its answer must not end the wait, even when it shows the
  // pull request no longer behind.
  test('a refresh already in flight at the click does not clear Queued, the next one does', async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = true;
    const stale = JSON.stringify(snapshot({ ...current, behind: false }));
    await page.route('**/api/dashboard/refresh', async (route: Route) => {
      if (held) {
        held = false;
        await gate;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: stale,
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(current)),
      });
    });

    // The refresh starts first and stays in flight across the click.
    await page.locator('#force-refresh-button').click();
    await row(page).getByRole('button', { name: 'Update branch' }).click();
    await expect(
      row(page).getByRole('button', { name: 'Queued…' }),
    ).toBeDisabled();

    release();
    await page.waitForTimeout(800);
    await expect(page.locator('#feedback-toasts')).not.toContainText(
      'Branch updated.',
    );
    await expect(line(page)).toContainText('Queued');

    // A refresh that starts after the click and shows the branch caught up.
    current = { ...current, behind: false, updateRequest: undefined };
    await page.locator('#force-refresh-button').click();
    await expect(page.locator('#feedback-toasts')).toContainText(
      'Branch updated.',
    );
  });
});
