import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
} from '@playwright/test';
import { test } from './fixtures';
import { registerViaInvite } from './register-helper';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// The pipeline panel reads its checks again only when a snapshot says its pull
// request's CI changed: no request while nothing changes, none for a finished
// pipeline, none while live updates are paused. The page's EventSource is
// stubbed so the test decides when a snapshot arrives.

declare global {
  interface Window {
    __push: (data: unknown) => void;
    __said: string[];
  }
}

type Counts = {
  passed: number;
  running: number;
  waiting: number;
  failed: number;
};

function pr(ci: string, checks: Counts) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Add structured logging',
    url: 'https://example.com/42',
    author: 'claude',
    draft: false,
    ci,
    checks,
    labels: [],
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    mergeStatus: 'blocked',
    status: 'blocked',
    kind: 'regular',
    behind: false,
    allowedActions: [],
  };
}

function snapshot(item: ReturnType<typeof pr>) {
  return {
    generatedAt: new Date().toISOString(),
    forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
    pullRequests: [item],
    issues: [],
  };
}

const RUNNING = pr('pending', { passed: 1, running: 1, waiting: 0, failed: 0 });
const PASSED = pr('success', { passed: 2, running: 0, waiting: 0, failed: 0 });

const RUN = [
  { name: 'build', state: 'success', url: 'https://example.com/r/1' },
  { name: 'test', state: 'running', url: 'https://example.com/r/2' },
];
const DONE = [
  { name: 'build', state: 'success', url: 'https://example.com/r/1' },
  { name: 'test', state: 'success', url: 'https://example.com/r/2' },
];

async function stubStream(page: Page) {
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

// Serves the first snapshot and whatever checks `current.checks` holds, and
// counts every checks request.
async function open(
  page: Page,
  first: ReturnType<typeof pr>,
  checks: unknown[],
) {
  const state = { checks, requests: 0, status: 200 };
  await stubStream(page);
  await page.route('**/api/dashboard', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot(first)),
    }),
  );
  await page.route('**/api/pull-requests/checks*', (route: Route) => {
    state.requests++;
    return route.fulfill({
      status: state.status,
      contentType: 'application/json',
      body: JSON.stringify(
        state.status === 200
          ? { checks: state.checks }
          : { error: 'forge unreachable' },
      ),
    });
  });
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: 'Open pipeline' })
    .click();
  await expect(page.locator('#pipeline-dialog .pipeline-check')).toHaveCount(2);

  return state;
}

async function push(page: Page, item: ReturnType<typeof pr>) {
  await page.waitForFunction(
    () =>
      (window as unknown as { __es?: { onmessage: unknown } }).__es
        ?.onmessage != null,
  );
  await page.evaluate((data) => window.__push(data), snapshot(item));
}

const dialog = (page: Page) => page.locator('#pipeline-dialog');

test.describe('pipeline panel updates live', () => {
  test.use({ storageState: SHARED_STORAGE_STATE_PATH });

  test('a check finishing changes its pill in place, announced once', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    const items = dialog(page).locator('.pipeline-check');
    await expect(items.nth(1)).toContainText('Running');

    state.checks = DONE;
    await push(page, PASSED);

    await expect(items.nth(1)).toContainText('Passed');
    await expect(items.nth(0)).toContainText('build');
    await expect(items).toHaveCount(2);
    expect(state.requests).toBe(2);
    await expect(dialog(page).locator('.pipeline-live-status')).toHaveText(
      'Checks updated: test is now Passed.',
    );
  });

  test('a failed live read says so and the next snapshot reads again', async ({
    page,
  }) => {
    const state = await open(page, RUNNING, RUN);
    state.checks = DONE;
    state.status = 500;
    await push(page, PASSED);

    await expect(dialog(page).locator('.pipeline-paused-note')).toHaveText(
      "Couldn't refresh these checks. They may be out of date.",
    );
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Running',
    );
    expect(state.requests).toBe(2);

    // The snapshot is the same as the one that failed, and still reads again.
    state.status = 200;
    await push(page, PASSED);

    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Passed',
    );
    await expect(dialog(page).locator('.pipeline-paused-note')).toBeHidden();
    expect(state.requests).toBe(3);
  });

  test('a change before the first read has drawn restarts that read', async ({
    page,
  }) => {
    await stubStream(page);
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(RUNNING)),
      }),
    );
    let requests = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/pull-requests/checks*', async (route: Route) => {
      requests++;
      // The first read is still out when the snapshot changes; it comes back
      // with the old checks.
      const first = requests === 1;
      if (first) await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ checks: first ? RUN : DONE }),
      });
    });
    await page.goto('/pull-requests.html');
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    await expect.poll(() => requests).toBe(1);

    await push(page, PASSED);
    await expect.poll(() => requests).toBe(2);
    release();

    const items = dialog(page).locator('.pipeline-check');
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toContainText('Passed');
    expect(requests).toBe(2);
  });

  test('two changes that read the same are each announced', async ({
    page,
  }) => {
    const pair = (state: string) => [
      { name: 'a', state, url: 'https://example.com/r/a' },
      { name: 'b', state, url: 'https://example.com/r/b' },
    ];
    const state = await open(page, RUNNING, pair('running'));
    // A screen reader speaks a live region when its text changes, so an
    // identical line has to come after the region was emptied.
    await dialog(page).evaluate((node) => {
      const region = node.querySelector('.pipeline-live-status');
      const seen: string[] = [];
      window.__said = seen;
      new MutationObserver(() => seen.push(region?.textContent ?? '')).observe(
        region as Element,
        { childList: true, characterData: true, subtree: true },
      );
    });
    const line = 'Checks updated: 2 checks changed.';
    const spoken = () =>
      page.evaluate(() => window.__said.filter((text) => text !== ''));

    state.checks = pair('success');
    await push(page, PASSED);
    await expect.poll(spoken).toEqual([line]);
    state.checks = pair('running');
    await push(page, RUNNING);

    await expect.poll(spoken).toEqual([line, line]);
    const all = await page.evaluate(() => window.__said);
    expect(all.slice(all.indexOf(line), all.lastIndexOf(line))).toContain('');
  });

  test('a snapshot with the same CI makes no request', async ({ page }) => {
    const state = await open(page, PASSED, DONE);
    await push(page, PASSED);
    await push(page, PASSED);
    expect(state.requests).toBe(1);
  });

  test('a rerun that starts reads the finished panel once more', async ({
    page,
  }) => {
    const state = await open(page, PASSED, DONE);
    state.checks = RUN;
    await push(page, RUNNING);
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Running',
    );
    expect(state.requests).toBe(2);
  });

  test('the order stays put when a check starts to fail', async ({ page }) => {
    const state = await open(page, RUNNING, RUN);
    state.checks = [
      { name: 'test', state: 'failure', url: 'https://example.com/r/2' },
      { name: 'build', state: 'success', url: 'https://example.com/r/1' },
    ];
    await push(
      page,
      pr('failure', { passed: 1, running: 0, waiting: 0, failed: 1 }),
    );
    const names = dialog(page).locator('.pipeline-check-name');
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Failed',
    );
    await expect(names).toHaveText(['build', 'test']);
  });

  test('a blocking failure listed first stays first through a live redraw', async ({
    page,
  }) => {
    const req = (name: string, state: string) => ({
      name,
      state,
      required: true,
      url: `https://example.com/r/${name}`,
    });
    const state = await open(page, RUNNING, [
      req('build', 'running'),
      req('lint', 'failure'),
    ]);
    const names = dialog(page).locator('.pipeline-check-name');
    await expect(names).toHaveText(['lint', 'build']);
    state.checks = [req('build', 'success'), req('lint', 'failure')];
    await push(
      page,
      pr('failure', { passed: 1, running: 0, waiting: 0, failed: 1 }),
    );
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Passed',
    );
    await expect(names).toHaveText(['lint', 'build']);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [390, 1280]) {
      test(`has no axe violations after a live update, ${scheme} at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        const state = await open(page, RUNNING, RUN);
        state.checks = DONE;
        await push(page, PASSED);
        await expect(
          dialog(page).locator('.pipeline-check').nth(1),
        ).toContainText('Passed');
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});

test.describe('pipeline panel with live updates paused', () => {
  test('makes no request, says so, passes axe, and reads once on resume', async ({
    page,
    request,
    baseURL,
  }: {
    page: Page;
    request: APIRequestContext;
    baseURL: string | undefined;
  }) => {
    await stubStream(page);
    await registerViaInvite(
      page,
      request,
      baseURL,
      `live-panel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      'Live Panel User',
    );
    const state = { requests: 0, checks: RUN as unknown[] };
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(RUNNING)),
      }),
    );
    await page.route('**/api/pull-requests/checks*', (route: Route) => {
      state.requests++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ checks: state.checks }),
      });
    });
    await page.goto('/pull-requests.html');
    await page.getByRole('button', { name: 'Pause live updates' }).click();
    await page
      .locator('#pr-rows .row')
      .first()
      .getByRole('button', { name: 'Open pipeline' })
      .click();
    await expect(dialog(page).locator('.pipeline-check')).toHaveCount(2);
    await expect(dialog(page).locator('.pipeline-paused-note')).toBeHidden();

    await push(page, PASSED);

    await expect(dialog(page).locator('.pipeline-paused-note')).toHaveText(
      'Live updates are paused. These checks may be out of date.',
    );
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Running',
    );
    expect(state.requests).toBe(1);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // Turning updates back on reads once, for the change that waited. The
    // button sits behind the modal panel, so the click is dispatched.
    state.checks = DONE;
    await page
      .getByRole('button', { name: 'Pause live updates' })
      .dispatchEvent('click');
    await expect(dialog(page).locator('.pipeline-check').nth(1)).toContainText(
      'Passed',
    );
    await expect(dialog(page).locator('.pipeline-paused-note')).toBeHidden();
    expect(state.requests).toBe(2);
  });
});
