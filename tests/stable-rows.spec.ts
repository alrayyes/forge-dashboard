import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import {
  allowedActionsFor,
  kindFor,
  statusFor,
} from './allowed-actions-stand-in';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// Live updates land by themselves. A snapshot (poll or SSE push) that adds,
// removes or moves rows waits only while something would be disturbed (an
// action in flight, another modal open, the pointer resting on the list) or
// updates are paused; one that only changes a row's own content updates that
// row in place. The page's EventSource is stubbed so
// the test decides exactly when a snapshot arrives.

declare global {
  interface Window {
    __push: (data: unknown) => void;
  }
}

async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
) {
  const username = `stable-rows-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await registerViaInvite(page, request, baseURL, username, 'Stable Rows User');
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
    createdAt: new Date(Date.now() - number * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - number * 60_000).toISOString(),
    mergeStatus: 'blocked',
    behind: false,
    ...overrides,
  };
}

function snapshot(prs: MockPR[]) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 2 }],
    // This spec stubs the whole stream, so the stand-in can't enrich what it
    // pushes: state the server's answer here.
    pullRequests: prs.map((pr) => ({
      ...pr,
      allowedActions: allowedActionsFor(pr),
      // And the status (#1375), or every row reads as changed against the
      // enriched first fetch.
      status: statusFor(pr),
      // Same for the kind (#716).
      kind: kindFor(pr),
    })),
    issues: [],
  };
}

async function push(page: Page, prs: MockPR[]) {
  // The rows can render from the first fetch before the dashboard has
  // attached its stream handler; a push that lands in that gap is dropped
  // and the updates bar never appears (#736).
  await page.waitForFunction(
    () =>
      (window as unknown as { __es?: { onmessage: unknown } }).__es
        ?.onmessage != null,
  );
  await page.evaluate((data) => window.__push(data), snapshot(prs));
}

async function titles(page: Page): Promise<string[]> {
  return page.locator('#pr-rows .row .title-text').allTextContents();
}

async function stubStream(page: Page) {
  // The stub has to be in place before the dashboard opens its stream.
  await page.addInitScript(() => {
    class StubEventSource {
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor() {
        (window as unknown as { __es: StubEventSource }).__es = this;
      }
      close() {}
      addEventListener() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource =
      StubEventSource;
    window.__push = (data) =>
      (window as unknown as { __es: StubEventSource }).__es.onmessage?.({
        data: JSON.stringify(data),
      });
  });
}

async function openInitial(page: Page, initial: MockPR[]) {
  await page.route('**/api/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(initial)),
    }),
  );
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows .row')).toHaveCount(2);
}

// Most of the file mocks the dashboard, stubs the stream and writes nothing per
// user, so it starts from the shared session instead of registering a user per
// test (#1379). The last group saves a choice (pause, a filter, the sort), which
// the server keeps for the user, so it keeps its own.
test.describe('stable rows', () => {
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  const initial = [makePR(1), makePR(2)];

  test.beforeEach(async ({ page }) => {
    await stubStream(page);
    await openInitial(page, initial);
  });

  test('a snapshot that adds a row lands by itself, with no button to press', async ({
    page,
  }) => {
    await push(page, [
      makePR(3, { updatedAt: new Date().toISOString() }),
      ...initial,
    ]);

    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
    expect((await titles(page))[0]).toContain('Pull request 3');
    await expect(
      page.getByRole('button', { name: 'Show updates' }),
    ).toHaveCount(0);
    await expect(page.getByText(/updates? available/)).toHaveCount(0);
  });

  test('a snapshot that reorders or removes rows lands by itself too', async ({
    page,
  }) => {
    await push(page, [initial[1]]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);

    await push(page, [makePR(3), initial[1], initial[0]]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
    expect((await titles(page))[0]).toContain('Pull request 3');
  });

  test('rows added wait while the pointer rests on the list, then land when it leaves', async ({
    page,
  }) => {
    await page.locator('#pr-rows .row').first().hover();
    await push(page, [makePR(3), ...initial]);
    await push(page, [
      makePR(1, { title: 'Changed title' }),
      initial[1],
      makePR(3),
    ]);

    // A changed row still updates where it stands; the new row waits.
    await expect(page.locator('#pr-rows .row').first()).toContainText(
      'Changed title',
    );
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);

    await page.mouse.move(2, 2);
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
  });

  test('rows wait while a modal other than the details dialog is open, then land', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const d = document.createElement('dialog');
      d.id = 'test-modal';
      d.textContent = 'Another modal';
      document.body.appendChild(d);
      (d as HTMLDialogElement).showModal();
    });
    await push(page, [makePR(3), ...initial]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);

    await page.evaluate(() =>
      (document.getElementById('test-modal') as HTMLDialogElement).close(),
    );
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
  });

  test('with the details dialog open the board behind it keeps updating and the dialog follows its pull request', async ({
    page,
  }) => {
    await page.locator('#pr-rows .row').first().locator('button.title').click();
    const dialog = page.getByRole('dialog', { name: /Pull request details/ });
    await expect(dialog).toBeVisible();

    await push(page, [makePR(3), makePR(1, { ci: 'failure' }), initial[1]]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Pull request 1');
    await expect(dialog.getByText(/fail/i).first()).toBeVisible();

    // The pull request leaving the board is said in the dialog, which stays.
    await push(page, [makePR(3), initial[1]]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
    await expect(dialog).toBeVisible();
  });

  test('a changed row updates in place without reordering or moving the scroll position', async ({
    page,
  }) => {
    const many = Array.from({ length: 24 }, (_, i) => makePR(i + 1));
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(many)),
      }),
    );
    await page.reload();
    await expect(page.locator('#pr-rows .row')).toHaveCount(24);
    await page.evaluate(() => window.scrollTo(0, 300));
    const before = await page.evaluate(() => window.scrollY);
    const order = await titles(page);

    // The last row becomes the most recently active: Last activity would
    // move it first.
    const next = many.map((pr) =>
      pr.number === 20
        ? { ...pr, ci: 'failure', updatedAt: new Date().toISOString() }
        : pr,
    );
    await push(page, next);
    await expect(
      page.locator('#pr-rows .row', { hasText: 'Pull request 20' }),
    ).toContainText('Failed');
    expect(await titles(page)).toEqual(order);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  });

  test('keyboard focus on a row survives a snapshot that adds rows', async ({
    page,
  }) => {
    const open = page.locator('#pr-rows .row').first().locator('button.title');
    await open.focus();
    await push(page, [makePR(3), ...initial]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
    await expect(
      page
        .locator('#pr-rows .row', { hasText: 'Pull request 1' })
        .locator('button.title'),
    ).toBeFocused();
  });

  test('applied arrivals are announced once, politely, and a content-only change is not', async ({
    page,
  }) => {
    const region = page.locator('#list-updates-status');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await push(page, [makePR(1, { ci: 'failure' }), initial[1]]);
    await expect(page.locator('#pr-rows .row').first()).toContainText('Failed');
    await expect(region).toHaveText('');

    const next = [makePR(3), makePR(1, { ci: 'failure' }), initial[1]];
    await push(page, next);
    await push(page, next);
    await expect(region).toHaveText('List updated: 1 added');
  });

  test('a content-only change updates the row in place and marks it Updated just now for a moment', async ({
    page,
  }) => {
    await push(page, [makePR(1, { ci: 'failure' }), initial[1]]);

    const first = page.locator('#pr-rows .row').first();
    await expect(first).toContainText('Failed');
    await expect(first).toContainText('Pull request 1');
    await expect(first.getByText('Updated just now')).toBeVisible();
    await expect(page.locator('#list-updates-status')).toHaveText('');

    // A couple of seconds, then the text goes away on its own.
    await expect(first.getByText('Updated just now')).toBeHidden({
      timeout: 6000,
    });
  });

  test('the Updated just now marker is text, with no animation under reduced motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await push(page, [makePR(1, { ci: 'failure' }), initial[1]]);
    const marker = page.getByText('Updated just now');
    await expect(marker).toBeVisible();
    const animation = await marker.evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(animation).toBe('none');
  });

  test('nothing re-renders while a More actions menu is open', async ({
    page,
  }) => {
    // Waiting on CI, so the row offers auto-merge and Close, and Close sits in
    // More actions next to it (a lone action is drawn directly, #1139).
    const waiting = { ci: 'pending', mergeStatus: 'blocked' };
    const bot = makePR(1, waiting);
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot([bot, initial[1]])),
      }),
    );
    await page.reload();
    const row = page.locator('#pr-rows .row').first();
    await row.getByRole('button', { name: 'More actions' }).click();

    await push(page, [makePR(1, { ...waiting, title: 'Changed' }), initial[1]]);
    await expect(row).not.toContainText('Changed');
    await page.keyboard.press('Escape');
    await expect(page.locator('#pr-rows .row').first()).toContainText(
      'Changed',
    );
  });

  // The first row with any part on screen: its key and where its top sits.
  const anchorRow = (page: Page) =>
    page.evaluate(() => {
      for (const row of document.querySelectorAll<HTMLElement>(
        '#pr-rows .row',
      )) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > 0)
          return { key: row.dataset.prKey ?? '', top: rect.top };
      }
      return null;
    });

  async function openMany(page: Page, count = 24) {
    const many = Array.from({ length: count }, (_, i) => makePR(i + 1));
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(many)),
      }),
    );
    await page.reload();
    await expect(page.locator('#pr-rows .row')).toHaveCount(count);
    return many;
  }

  test('a row inserted above the viewport does not move the rows on screen or a focused button', async ({
    page,
  }) => {
    const many = await openMany(page);
    await page.evaluate(() => window.scrollTo(0, 600));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    const button = page
      .locator('#pr-rows .row', { hasText: 'Pull request 12' })
      .locator('button.title');
    await button.focus();
    const before = await anchorRow(page);
    const buttonTop = (await button.boundingBox())?.y ?? 0;

    await push(page, [
      makePR(99, { updatedAt: new Date().toISOString() }),
      ...many,
    ]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(25);

    const after = await anchorRow(page);
    expect(after?.key).toBe(before?.key);
    expect(
      Math.abs((after?.top ?? 0) - (before?.top ?? 0)),
    ).toBeLessThanOrEqual(1);
    await expect(button).toBeFocused();
    expect(
      Math.abs(((await button.boundingBox())?.y ?? 0) - buttonTop),
    ).toBeLessThanOrEqual(1);
  });

  // Only the id can find the button again: its text changed with the title.
  test('focus on a row follows its open button by id when its title changes in the same snapshot as an insert above', async ({
    page,
  }) => {
    const many = await openMany(page);
    await page.evaluate(() => window.scrollTo(0, 600));
    const button = page
      .locator('#pr-rows .row', { hasText: 'Pull request 12' })
      .locator('button.title');
    await button.focus();

    await push(page, [
      makePR(99, { updatedAt: new Date().toISOString() }),
      ...many.map((pr) =>
        pr.number === 12 ? { ...pr, title: 'A different title' } : pr,
      ),
    ]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(25);
    await expect(page.locator('#pr-rows button.title:focus')).toContainText(
      'A different title',
    );
  });

  test('a touch holds added rows for a moment, then they land', async ({
    page,
  }) => {
    await page.evaluate(() =>
      document.body.dispatchEvent(
        new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }),
      ),
    );
    await push(page, [makePR(3), ...initial]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
  });

  test('a touch scroll holds added rows until the scroll settles', async ({
    page,
  }) => {
    const many = await openMany(page);
    const t0 = Date.now();
    await page.evaluate(async () => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          bubbles: true,
        }),
      );
      for (let y = 100; y <= 400; y += 100) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 300));
      }
    });
    await push(page, [makePR(99), ...many]);
    expect(await page.locator('#pr-rows .row').count()).toBe(24);
    await expect(page.locator('#pr-rows .row')).toHaveCount(25);
    expect(Date.now() - t0).toBeGreaterThan(1000);
  });

  test('a row added that the filters hide is not announced', async ({
    page,
  }) => {
    await page
      .locator('.filter-bar .col-filter[data-col="title"]')
      .fill('Pull request 1');
    await push(page, [makePR(3, { title: 'Something else' }), ...initial]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(page.locator('#list-updates-status')).toHaveText('');
  });

  test('the announcement clears itself after ten seconds', async ({ page }) => {
    await page.clock.install();
    await push(page, [makePR(3), ...initial]);
    await expect(page.locator('#list-updates-status')).toHaveText(
      'List updated: 1 added',
    );
    await page.clock.fastForward(10_500);
    await expect(page.locator('#list-updates-status')).toHaveText('');
  });

  test('when the pull request in the open dialog left the board, closing it puts focus on the first row, not the page', async ({
    page,
  }) => {
    await page.locator('#pr-rows .row').first().locator('button.title').click();
    const dialog = page.getByRole('dialog', { name: /Pull request details/ });
    await expect(dialog).toBeVisible();
    await push(page, [initial[1]]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#pr-rows button.title').first()).toBeFocused();
  });

  test('losing the window clears the pointer hold, so rows land after an alt-tab', async ({
    page,
  }) => {
    await page.locator('#pr-rows .row').first().hover();
    await push(page, [makePR(3), ...initial]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
  });

  test('closing a dialog ends the pointer hold until the mouse moves again', async ({
    page,
  }) => {
    const row = page.locator('#pr-rows .row').first();
    await row.hover();
    await row.locator('button.title').click();
    const dialog = page.getByRole('dialog', { name: /Pull request details/ });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The mouse hasn't moved: it no longer claims the list.
    await push(page, [makePR(3), ...initial]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
  });

  test('a refresh the user asked for lands at once, even with the pointer on the list', async ({
    page,
  }) => {
    await page.route('**/api/dashboard/refresh*', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot([makePR(3), ...initial])),
      }),
    );
    await page.locator('#pr-rows .row').first().hover();
    await page.evaluate(() =>
      document.getElementById('force-refresh-button')?.click(),
    );
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
  });
});

test.describe('stable rows: choices the server saves', () => {
  const initial = [makePR(1), makePR(2)];

  test.beforeEach(async ({ page, request, baseURL }) => {
    await stubStream(page);
    await registerAndSignIn(page, request, baseURL);
    await openInitial(page, initial);
  });

  test('Pause live updates stops everything from applying, and the choice persists', async ({
    page,
  }) => {
    const pause = page.getByRole('button', { name: 'Pause live updates' });
    await expect(pause).toHaveAttribute('aria-pressed', 'false');
    await pause.click();
    await expect(pause).toHaveAttribute('aria-pressed', 'true');

    await push(page, [makePR(3), makePR(1, { ci: 'failure' }), initial[1]]);
    await expect(page.locator('#updates-paused-hint')).toBeVisible();
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
    await expect(page.locator('#pr-rows .row').first()).not.toContainText(
      'Failed',
    );

    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Pause live updates' }),
    ).toHaveAttribute('aria-pressed', 'true');

    // Resuming applies what waited.
    await push(page, [makePR(3), makePR(1, { ci: 'failure' }), initial[1]]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
    await page.getByRole('button', { name: 'Pause live updates' }).click();
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
    await expect(
      page.locator('#pr-rows .row', { hasText: 'Pull request 1' }),
    ).toContainText('Failed');
  });

  test('the sort control orders rows and a snapshot never re-sorts them', async ({
    page,
  }) => {
    await page.getByLabel('Sort pull requests by').selectOption('created');
    expect((await titles(page))[0]).toContain('Pull request 1');

    // Pull request 2 becomes the most recently active: Last activity would
    // move it first, Created keeps it where it was.
    await push(page, [
      initial[0],
      makePR(2, { updatedAt: new Date().toISOString(), title: 'Renamed 2' }),
    ]);
    await expect(page.locator('#pr-rows .row').nth(1)).toContainText(
      'Renamed 2',
    );
    expect((await titles(page))[0]).toContain('Pull request 1');

    await page.getByLabel('Sort pull requests by').selectOption('repo');
    await expect(page.getByLabel('Sort pull requests by')).toHaveValue('repo');

    await page.reload();
    await expect(page.getByLabel('Sort pull requests by')).toHaveValue('repo');
  });

  // Pausing saves a choice for the user, so this sits with the other
  // spec that does.
  test('has no axe violations after live rows arrive, with the pause control showing', async ({
    page,
  }) => {
    await push(page, [makePR(3), ...initial]);
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
    await page.getByRole('button', { name: 'Pause live updates' }).click();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
