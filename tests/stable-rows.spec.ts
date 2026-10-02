import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { registerViaInvite } from './register-helper';

// #710: rows stay where they are while the user reads and clicks. A live
// snapshot (poll or SSE push) that would move, add or remove rows is held
// behind an "N updates available" bar; one that only changes a row's own
// content updates that row in place. The page's EventSource is stubbed so
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
    pullRequests: prs,
    issues: [],
  };
}

async function push(page: Page, prs: MockPR[]) {
  await page.evaluate((data) => window.__push(data), snapshot(prs));
}

async function titles(page: Page): Promise<string[]> {
  return page.locator('#pr-rows .row .title-text').allTextContents();
}

test.describe('stable rows (#710)', () => {
  const initial = [makePR(1), makePR(2)];

  test.beforeEach(async ({ page, request, baseURL }) => {
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
    await registerAndSignIn(page, request, baseURL);
    await page.route('**/api/dashboard', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot(initial)),
      }),
    );
    await page.reload();
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);
  });

  test('a snapshot that adds a row is held behind an updates bar until asked for', async ({
    page,
  }) => {
    await push(page, [
      makePR(3, { updatedAt: new Date().toISOString() }),
      ...initial,
    ]);

    await expect(page.locator('#updates-count')).toHaveText(
      '1 update available',
    );
    expect(await titles(page)).toEqual([
      expect.stringContaining('Pull request 1'),
      expect.stringContaining('Pull request 2'),
    ]);

    await page.getByRole('button', { name: 'Show updates' }).click();
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
    expect((await titles(page))[0]).toContain('Pull request 3');
    await expect(page.locator('#updates-count')).toHaveText('');
    await expect(
      page.getByRole('button', { name: 'Show updates' }),
    ).toBeHidden();
    // Focus stays in the bar rather than falling back to the page.
    await expect(
      page.getByRole('button', { name: 'Pause live updates' }),
    ).toBeFocused();
  });

  test('a snapshot that reorders or removes rows is held too', async ({
    page,
  }) => {
    await push(page, [initial[1]]);
    await expect(page.locator('#updates-count')).toHaveText(
      '1 update available',
    );
    await expect(page.locator('#pr-rows .row')).toHaveCount(2);

    await push(page, [makePR(3), initial[1], initial[0]]);
    await expect(page.locator('#updates-count')).toHaveText(
      '2 updates available',
    );
    expect((await titles(page))[0]).toContain('Pull request 1');
  });

  test('a content-only change updates the row in place and marks it Updated just now for a moment', async ({
    page,
  }) => {
    await push(page, [makePR(1, { ci: 'failure' }), initial[1]]);

    const first = page.locator('#pr-rows .row').first();
    await expect(first).toContainText('Failing');
    await expect(first).toContainText('Pull request 1');
    await expect(first.getByText('Updated just now')).toBeVisible();
    await expect(page.locator('#updates-count')).toHaveText('');

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

  test('Pause live updates stops everything from applying, and the choice persists', async ({
    page,
  }) => {
    const pause = page.getByRole('button', { name: 'Pause live updates' });
    await expect(pause).toHaveAttribute('aria-pressed', 'false');
    await pause.click();
    await expect(pause).toHaveAttribute('aria-pressed', 'true');

    await push(page, [makePR(1, { ci: 'failure' }), initial[1]]);
    await expect(page.locator('#updates-count')).toHaveText(
      '1 update available',
    );
    await expect(page.locator('#pr-rows .row').first()).not.toContainText(
      'Failing',
    );

    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Pause live updates' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Pause live updates' }).click();
    await push(page, [makePR(1, { ci: 'failure' }), initial[1]]);
    await expect(page.locator('#pr-rows .row').first()).toContainText(
      'Failing',
    );
  });

  test('changing a filter applies the pending snapshot', async ({ page }) => {
    await push(page, [
      makePR(3, { updatedAt: new Date().toISOString() }),
      ...initial,
    ]);
    await expect(page.locator('#updates-count')).toHaveText(
      '1 update available',
    );
    await page
      .locator('.quick-pills')
      .getByRole('button', { name: 'GitHub', exact: true })
      .click();
    await expect(page.locator('#pr-rows .row')).toHaveCount(3);
    await expect(page.locator('#updates-count')).toHaveText('');
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

  test('nothing re-renders under focus in a row, and the change lands once focus leaves', async ({
    page,
  }) => {
    const link = page.locator('#pr-rows .row').first().locator('a.title');
    await link.focus();
    await push(page, [makePR(1, { title: 'Changed title' }), initial[1]]);
    await expect(page.locator('#updates-count')).toHaveText(
      '1 update available',
    );
    await expect(link).toBeFocused();
    await expect(link).toContainText('Pull request 1');

    await page.locator('#shared-group-select').focus();
    await expect(page.locator('#pr-rows .row').first()).toContainText(
      'Changed title',
    );
  });

  test('nothing re-renders while a More actions menu is open', async ({
    page,
  }) => {
    const bot = makePR(1, { author: 'dependabot' });
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

    await push(page, [
      makePR(1, { author: 'dependabot', title: 'Changed' }),
      initial[1],
    ]);
    await expect(page.locator('#updates-count')).toHaveText(
      '1 update available',
    );
    await expect(row).not.toContainText('Changed');
    await page.keyboard.press('Escape');
    await expect(page.locator('#pr-rows .row').first()).toContainText(
      'Changed',
    );
  });

  test('the bar announces politely, once per change in the count, not per poll', async ({
    page,
  }) => {
    const region = page.locator('#updates-count');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await region.evaluate((el) => {
      (window as unknown as { __mutations: number }).__mutations = 0;
      new MutationObserver(() => {
        (window as unknown as { __mutations: number }).__mutations += 1;
      }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const next = [makePR(3), ...initial];
    await push(page, next);
    await push(page, next);
    await push(page, next);
    await expect(region).toHaveText('1 update available');
    const mutations = await page.evaluate(
      () => (window as unknown as { __mutations: number }).__mutations,
    );
    expect(mutations).toBeLessThanOrEqual(2);
  });

  test('has no axe violations with the updates bar showing', async ({
    page,
  }) => {
    await push(page, [makePR(3), ...initial]);
    await expect(page.locator('#updates-count')).toHaveText(
      '1 update available',
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
