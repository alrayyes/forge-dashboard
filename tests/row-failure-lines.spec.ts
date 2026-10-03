import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #752: a failure line on a row says one plain sentence, never the raw
// error string; it can be dismissed and goes away by itself when it no
// longer applies; Retry shows only for a reason that can pass; and it wraps
// on a phone.

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `failure-line-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(
    page,
    request,
    baseURL,
    username,
    'Failure Line User',
  );
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

function makePR(overrides: Partial<MockPR> = {}): MockPR {
  return {
    forge: 'forgejo',
    repo: 'someone/some-repo',
    number: 42,
    title: 'A pull request',
    url: 'https://example.com/42',
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
    forges: [{ forge: 'forgejo', reachable: true, repoCount: 1 }],
    pullRequests: prs,
    issues: [],
  };
}

const RAW =
  'dashboard: update pull request: forgejo: POST /repos/someone/some-repo/pulls/42/update: {"message":"","url":"https://forge.example/api/swagger"}';

const row = (page: Page) => page.locator('#pr-rows .row').first();
const line = (page: Page) => row(page).locator('.row-feedback-line');

async function prepare(
  page: Page,
  failure: { status: number; body: unknown },
  prs: MockPR[] = [makePR()],
) {
  let current = prs;
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(current)),
    }),
  );
  await page.route('**/api/pull-requests/update-branch', (route: Route) =>
    route.fulfill({
      status: failure.status,
      contentType: 'application/json',
      body: JSON.stringify(failure.body),
    }),
  );
  await page.route('**/api/dashboard/refresh', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(current)),
    }),
  );
  await page.reload();
  return (next: MockPR[]) => {
    current = next;
  };
}

async function fail(page: Page) {
  await row(page).getByRole('button', { name: 'Update branch' }).click();
  await expect(line(page)).toContainText('Failed');
}

test.describe('row failure lines (#752)', () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await registerAndSignIn(page, request, baseURL);
    await page.route('**/api/settings/bot-pr-updates', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowBotPrUpdates: false }),
      }),
    );
  });

  test('a raw server error never reaches the row or the toast', async ({
    page,
  }) => {
    await prepare(page, { status: 500, body: { error: RAW } });
    await fail(page);

    const shown = `${await row(page).innerText()}\n${await page.locator('#feedback-toasts').innerText()}`;
    expect(shown).not.toMatch(
      /dashboard:|forgejo:|\/repos\/|https?:\/\/|swagger|\{"/,
    );
    await expect(line(page)).toContainText(
      'The forge refused this action and gave no reason.',
    );
  });

  test('an empty or unparsable answer reads as the same plain sentence', async ({
    page,
  }) => {
    await prepare(page, { status: 500, body: { message: '' } });
    await fail(page);
    await expect(line(page)).toContainText(
      'The forge refused this action and gave no reason.',
    );
  });

  test('a failure line has a Dismiss button, and the line goes away', async ({
    page,
  }) => {
    await prepare(page, { status: 500, body: { error: RAW } });
    await fail(page);

    await line(page)
      .getByRole('button', { name: /^Dismiss/ })
      .click();
    await expect(page.locator('#pr-rows .row-feedback-line')).toHaveCount(0);
  });

  test('Clear finished in Activity clears the failure line too', async ({
    page,
  }) => {
    await prepare(page, { status: 500, body: { error: RAW } });
    await fail(page);

    await page.locator('#activity-toggle').click();
    await page
      .locator('#activity-panel')
      .getByRole('button', { name: 'Clear finished' })
      .click();
    await expect(page.locator('#pr-rows .row-feedback-line')).toHaveCount(0);
  });

  test('the line clears by itself once a snapshot shows the pull request gone', async ({
    page,
  }) => {
    const setSnapshot = await prepare(page, {
      status: 500,
      body: { error: RAW },
    });
    await fail(page);

    setSnapshot([]);
    await page.locator('#force-refresh-button').click();
    await expect(page.locator('#pr-rows .row')).toHaveCount(0);
    await page.locator('#activity-toggle').click();
    await expect(
      page.locator('#activity-panel .activity-item', { hasText: 'Failed' }),
    ).toHaveCount(0);
  });

  test('acting on the row again clears the earlier failure line', async ({
    page,
  }) => {
    await prepare(page, { status: 500, body: { error: RAW } });
    // Held open, so the Closing… line stays put while it's asserted on: an
    // instant answer clears the line between the assertions (#803).
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/pull-requests/close', async (route: Route) => {
      await held;
      return route.fulfill({ status: 204 });
    });
    await fail(page);

    // A different action on the same row: its own start replaces the old
    // failure rather than stacking a second line beside it.
    await row(page).getByRole('button', { name: 'More actions' }).click();
    await row(page).getByRole('button', { name: 'Close', exact: true }).click();
    await row(page).getByRole('button', { name: 'Confirm close?' }).click();
    await expect(line(page)).toHaveCount(1);
    await expect(line(page)).toContainText('Closing');
    await expect(line(page)).not.toContainText('Update branch');
    await expect(line(page)).not.toContainText('Failed');
    release();
  });

  test('Retry shows for a transient failure, not for one that cannot pass', async ({
    page,
  }) => {
    await prepare(page, { status: 502, body: { error: RAW } });
    await fail(page);
    await expect(
      line(page).getByRole('button', { name: /^Retry/ }),
    ).toBeVisible();

    await page.unroute('**/api/pull-requests/update-branch');
    await page.route('**/api/pull-requests/update-branch', (route: Route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: RAW,
          code: 'permission',
          message: 'The token lacks permission.',
        }),
      }),
    );
    await line(page)
      .getByRole('button', { name: /^Retry/ })
      .click();
    await expect(page.locator('#feedback-toasts')).toContainText('permission');
    await expect(
      page.locator('#pr-rows').getByRole('button', { name: /^Retry/ }),
    ).toHaveCount(0);
  });

  test('on a phone the line wraps, its buttons are 44px tall and axe finds nothing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await prepare(page, { status: 502, body: { error: RAW } });
    await fail(page);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(375);
    const lineBox = await line(page).boundingBox();
    expect(lineBox?.x ?? 0).toBeGreaterThanOrEqual(0);
    expect((lineBox?.x ?? 0) + (lineBox?.width ?? 0)).toBeLessThanOrEqual(375);
    for (const name of [/^Retry/, /^Dismiss/]) {
      const box = await line(page).getByRole('button', { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
