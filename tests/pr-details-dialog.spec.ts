import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './fixtures';
import { settle } from './settle-helper';
import { SHARED_STORAGE_STATE_PATH } from './shared-session';

// Mocks /api/dashboard and /api/pull-requests/details only, writes no per-user
// state, so it starts from the shared session (#1379).
test.use({ storageState: SHARED_STORAGE_STATE_PATH });

// A valid 1x1 PNG, for an avatar that has to load.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const NOW = new Date();
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number: 42,
    title: 'Add structured logging',
    url: 'https://example.com/42',
    author: 'ryankes',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: ago(60),
    updatedAt: ago(5),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'regular',
    ...overrides,
  };
}

const noReactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

function body(text: string, extra: Record<string, unknown> = {}) {
  return {
    text,
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions: noReactions,
    ...extra,
  };
}

// A fresh URL per call: the browser's image cache must not carry an answer
// from one test (loaded, or failed) into another.
const uniq = () => Math.random().toString(36).slice(2);

function comment(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    author: {
      login: 'alice',
      avatarUrl: `https://example.invalid/${id}-${uniq()}.png`,
    },
    createdAt: ago(120),
    updatedAt: null,
    edited: false,
    text: `Comment ${id}`,
    format: 'markdown',
    truncated: false,
    reactions: noReactions,
    ...extra,
  };
}

function details(overrides: Record<string, unknown> = {}) {
  return {
    description: body('This adds **structured** logging.'),
    comments: [],
    commentCount: 0,
    commentsTruncated: false,
    releaseNotes: null,
    ...overrides,
  };
}

async function mockDashboard(page: Page, pullRequests: unknown[]) {
  await page.route('**/api/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests,
        issues: [],
      }),
    }),
  );
}

async function mockDetails(page: Page, payload: unknown, status = 200) {
  const urls: string[] = [];
  await page.route('**/api/pull-requests/details*', (route: Route) => {
    urls.push(route.request().url());
    return route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  return urls;
}

const trigger = (page: Page) =>
  page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', {
      name: /^Details/,
    });
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });

test.describe('pull request details dialog', () => {
  test('opens from the row trigger by mouse, fetches once and shows the header and description', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    const urls = await mockDetails(page, details());
    await page.goto('/pull-requests.html');

    await trigger(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('alrayyes/forge-dashboard #42');
    await expect(dialog(page)).toContainText('Add structured logging');
    await expect(dialog(page).getByText('GitHub').first()).toBeVisible();
    await expect(dialog(page).locator('strong')).toHaveText('structured');
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]);
    expect(url.searchParams.get('forge')).toBe('github');
    expect(url.searchParams.get('fullName')).toBe('alrayyes/forge-dashboard');
    expect(url.searchParams.get('number')).toBe('42');
    await expect(
      dialog(page).getByRole('link', { name: /Open on GitHub/ }),
    ).toHaveAttribute('href', 'https://example.com/42');
  });

  test('opens with Enter, Escape closes it and focus returns to the trigger', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await mockDetails(page, details());
    await page.goto('/pull-requests.html');

    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  });

  test('shows a loading skeleton, then the content', async ({ page }) => {
    await mockDashboard(page, [makePR()]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/pull-requests/details*', async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(details()),
      });
    });
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    await expect(dialog(page).getByText('Loading details')).toBeVisible();
    release();
    await expect(dialog(page).locator('strong')).toHaveText('structured');
    await expect(dialog(page).getByText('Loading details')).toHaveCount(0);
  });

  test('reaction pills show a count, name who gave them and say "and N more"', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await mockDetails(
      page,
      details({
        description: body('d', {
          reactions: {
            thumbsUp: { count: 3, logins: ['alice', 'bob', 'carol'] },
            thumbsDown: { count: 0, logins: [] },
          },
        }),
        comments: [
          comment('c1', {
            reactions: {
              thumbsUp: { count: 0, logins: [] },
              thumbsDown: {
                count: 12,
                logins: [
                  'u1',
                  'u2',
                  'u3',
                  'u4',
                  'u5',
                  'u6',
                  'u7',
                  'u8',
                  'u9',
                  'u10',
                ],
              },
            },
          }),
        ],
        commentCount: 1,
      }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();

    const up = dialog(page).getByRole('group', {
      name: '3 thumbs up, from alice, bob and carol',
    });
    await expect(up).toBeVisible();
    // Zero counts show nothing: one thumbs-up pill and one thumbs-down pill.
    await expect(dialog(page).locator('.reaction-pill')).toHaveCount(2);
    // Display only: nothing here is a button.
    await expect(dialog(page).locator('.reaction button')).toHaveCount(0);
    const down = dialog(page).getByRole('group', {
      name: /^12 thumbs down, from u1,.* and 2 more$/,
    });
    await expect(down).toBeVisible();

    const list = dialog(page).locator('.reaction-people');
    // The dialog opened under the pointer, which may rest on a pill.
    await page.mouse.move(0, 0);
    await expect(list).toHaveCount(0);
    await up.hover();
    await expect(list).toBeVisible();
    await expect(list).toContainText('alice');
    // Hoverable (WCAG 1.4.13): the pointer can move onto the list.
    await list.hover();
    await expect(list).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(list).toHaveCount(0);
    await up.focus();
    await expect(list).toBeVisible();
  });

  test('Escape dismisses the reaction list first and closes the dialog on the second press', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await mockDetails(
      page,
      details({
        description: body('d', {
          reactions: {
            thumbsUp: { count: 2, logins: ['alice', 'bob'] },
            thumbsDown: { count: 0, logins: [] },
          },
        }),
      }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const up = dialog(page).getByRole('group', { name: /thumbs up/ });
    await up.focus();
    await expect(dialog(page).locator('.reaction-people')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page).locator('.reaction-people')).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    await expect(up).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  });

  test('Escape dismisses a list opened by hover, too', async ({ page }) => {
    await mockDashboard(page, [makePR()]);
    await mockDetails(
      page,
      details({
        description: body('d', {
          reactions: {
            thumbsUp: { count: 2, logins: ['alice', 'bob'] },
            thumbsDown: { count: 0, logins: [] },
          },
        }),
      }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    await dialog(page)
      .getByRole('group', { name: /thumbs up/ })
      .hover();
    await expect(dialog(page).locator('.reaction-people')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page).locator('.reaction-people')).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
  });

  test('comments show oldest first with avatar, login, relative time and edited; a deleted author reads ghost', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await page.route('https://example.invalid/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(PNG_1X1, 'base64'),
      }),
    );
    await mockDetails(
      page,
      details({
        comments: [
          comment('c1', {
            text: 'first one',
            edited: true,
            updatedAt: ago(30),
          }),
          comment('c2', {
            text: 'second one',
            author: null,
            createdAt: ago(10),
          }),
        ],
        commentCount: 2,
      }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();

    const items = dialog(page).locator('.details-comment');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('first one');
    await expect(items.nth(0)).toContainText('alice');
    await expect(items.nth(0)).toContainText('2h ago');
    await expect(items.nth(0)).toContainText('edited');
    await expect(items.nth(1)).toContainText('ghost');
    await expect(items.nth(1)).not.toContainText('edited');
    const img = items.nth(0).locator('img.avatar');
    await expect(img).toHaveAttribute('alt', '');
    const box = await img.boundingBox();
    expect(box?.width).toBe(32);
    expect(box?.height).toBe(32);
    // No avatar for a deleted account: an initial in a circle.
    await expect(items.nth(1).locator('.avatar')).toHaveText('?');
  });

  test('an avatar that fails to load falls back to an initial', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await page.route('https://example.invalid/**', (route) => route.abort());
    await mockDetails(
      page,
      details({ comments: [comment('c1')], commentCount: 1 }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const avatar = dialog(page).locator('.details-comment .avatar').first();
    await expect(avatar).toHaveText('A');
    await expect(dialog(page).locator('img.avatar')).toHaveCount(0);
  });

  test('past 50 comments it says so and links to the forge', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await mockDetails(
      page,
      details({
        comments: Array.from({ length: 50 }, (_, i) => comment(`c${i}`)),
        commentCount: 73,
        commentsTruncated: true,
      }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    await expect(
      dialog(page).getByText('Showing the first 50 of 73 comments'),
    ).toBeVisible();
    await expect(
      dialog(page).getByRole('link', { name: /Read the rest on GitHub/ }),
    ).toHaveAttribute('href', 'https://example.com/42');
  });

  test('a release pull request shows release notes in place of the description', async ({
    page,
  }) => {
    await mockDashboard(page, [
      makePR({ kind: 'release', title: 'chore(main): release 1.2.0' }),
    ]);
    await mockDetails(
      page,
      details({
        description: body('the description text'),
        releaseNotes: body('## Features\n\n* add a thing\n'),
      }),
    );
    await page.goto('/releases.html');
    await trigger(page).click();
    await expect(
      dialog(page).getByRole('heading', { name: 'Release notes' }),
    ).toBeVisible();
    await expect(dialog(page).getByText('add a thing')).toBeVisible();
    await expect(dialog(page).getByText('the description text')).toHaveCount(0);
  });

  test('a bot pull request opens the same dialog with long generated text collapsed', async ({
    page,
  }) => {
    await mockDashboard(page, [
      makePR({ kind: 'dependency', author: 'dependabot[bot]' }),
    ]);
    await mockDetails(
      page,
      details({
        description: body('Bumps x from 1 to 2.\n\n' + 'notes\n\n'.repeat(5)),
      }),
    );
    await page.goto('/bots.html');
    await trigger(page).click();
    const fold = dialog(page).locator('details.details-collapsed');
    await expect(fold).toBeVisible();
    await expect(fold).not.toHaveAttribute('open', '');
    await expect(fold.getByText('notes').first()).toBeHidden();
    await fold.locator('summary').click();
    await expect(fold.getByText('notes').first()).toBeVisible();
  });

  test('an error says why and Try again fetches again', async ({ page }) => {
    await mockDashboard(page, [makePR()]);
    let calls = 0;
    await page.route('**/api/pull-requests/details*', (route) => {
      calls++;
      if (calls === 1) {
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'GitHub rate limit reached' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(details()),
      });
    });
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText(
      'GitHub rate limit reached',
    );
    await dialog(page).getByRole('button', { name: 'Try again' }).click();
    await expect(dialog(page).locator('strong')).toHaveText('structured');
    expect(calls).toBe(2);
  });

  test('a slow answer for a closed dialog never lands in the next one', async ({
    page,
  }) => {
    await mockDashboard(page, [
      makePR(),
      makePR({
        number: 43,
        title: 'Second one',
        url: 'https://example.com/43',
      }),
    ]);
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await page.route('**/api/pull-requests/details*', async (route) => {
      const number = new URL(route.request().url()).searchParams.get('number');
      if (number === '42') await gate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          details({ description: body(`description for ${number}`) }),
        ),
      });
    });
    await page.goto('/pull-requests.html');
    await page
      .locator('#pr-rows .row')
      .nth(0)
      .getByRole('button', { name: /^Details/ })
      .click();
    await page.keyboard.press('Escape');
    await page
      .locator('#pr-rows .row')
      .nth(1)
      .getByRole('button', { name: /^Details/ })
      .click();
    await expect(dialog(page)).toContainText('description for 43');
    const stale = page.waitForResponse((r) => r.url().includes('number=42'));
    releaseFirst();
    await stale;
    await settle(page);
    await expect(dialog(page)).toContainText('description for 43');
    await expect(dialog(page)).not.toContainText('description for 42');
  });

  test('raw HTML and javascript: links in a description or comment never become live markup', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    const hostile =
      '<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned = 2">\n\n[click](javascript:window.__pwned=3) [ok](https://example.org/x)';
    await mockDetails(
      page,
      details({
        description: body(hostile),
        comments: [comment('c1', { text: hostile })],
        commentCount: 1,
      }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const content = dialog(page).locator('.details-body');
    await expect(
      content.getByRole('link', { name: 'ok' }).first(),
    ).toBeVisible();
    await expect(content.locator('script')).toHaveCount(0);
    await expect(content.locator('img:not(.avatar)')).toHaveCount(0);
    await expect(content.locator('a[href^="javascript:" i]')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as never as { __pwned?: number }).__pwned,
      ),
    ).toBeUndefined();
    const ok = content.getByRole('link', { name: 'ok' }).first();
    await expect(ok).toHaveAttribute('target', '_blank');
    await expect(ok).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('on a 360px phone the dialog is a full-height sheet with no horizontal scroll and 44px targets', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await mockDashboard(page, [makePR()]);
    await mockDetails(
      page,
      details({
        description: body(
          '```\n' +
            'x'.repeat(200) +
            '\n```\n\nhttps://example.com/' +
            'a'.repeat(120),
        ),
        comments: [comment('c1')],
        commentCount: 1,
      }),
    );
    await page.goto('/pull-requests.html');
    const rowTrigger = await trigger(page).boundingBox();
    expect(rowTrigger?.height).toBeGreaterThanOrEqual(44);
    await trigger(page).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    const box = await d.boundingBox();
    expect(box?.width).toBe(360);
    expect(box?.height).toBe(740);
    const overflow = await d.evaluate((el) => {
      const body = el.querySelector('.details-body') as HTMLElement;
      return [
        el.scrollWidth - el.clientWidth,
        body.scrollWidth - body.clientWidth,
      ];
    });
    expect(overflow).toEqual([0, 0]);
    for (const control of [
      d.getByRole('button', { name: /^Close/ }),
      d.getByRole('link', { name: /Open on GitHub/ }),
    ]) {
      const b = await control.boundingBox();
      expect(b?.height).toBeGreaterThanOrEqual(44);
      expect(b?.width).toBeGreaterThanOrEqual(44);
    }
  });

  test('a failed markdown chunk shows a plain error and Try again recovers once the network is back', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await mockDetails(page, details());
    let failChunks = false;
    await page.route('**/_app/immutable/**/*.js', (route) =>
      failChunks ? route.abort() : route.continue(),
    );
    await page.goto('/pull-requests.html');
    await expect(trigger(page)).toBeVisible();
    failChunks = true;
    await trigger(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText(
      'Could not load the details',
    );
    // Technical text stays out of the UI.
    await expect(dialog(page).getByRole('alert')).not.toContainText('/_app/');
    await expect(dialog(page).getByRole('alert')).not.toContainText(
      'dynamically imported',
    );
    failChunks = false;
    await dialog(page).getByRole('button', { name: 'Try again' }).click();
    await expect(dialog(page).locator('strong')).toHaveText('structured');
  });

  test('a network failure reads as plain words, a server error shows its reason', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await page.route('**/api/pull-requests/details*', (route) => route.abort());
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText(
      'Could not load the details',
    );
    await expect(dialog(page).getByRole('alert')).not.toContainText(
      'Failed to fetch',
    );
  });

  test('an avatar is shown only from an https URL; other schemes fall back to the initial', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await page.route('https://example.invalid/**', (route) => route.abort());
    const httpsUrl = `https://example.invalid/${uniq()}.png`;
    const avatar = (id: string, url: string) =>
      comment(id, { author: { login: `user${id}`, avatarUrl: url } });
    await mockDetails(
      page,
      details({
        comments: [
          avatar('1', 'javascript:window.__pwned=1'),
          avatar(
            '2',
            'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
          ),
          avatar('3', 'http://example.invalid/http.png'),
          avatar('4', httpsUrl),
        ],
        commentCount: 4,
      }),
    );
    const requested: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('example.invalid')) requested.push(r.url());
    });
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    await expect(dialog(page).locator('.details-comment')).toHaveCount(4);
    // Only the https one is ever requested (it fails to load here, which also
    // falls back to the initial, so all four end as initials).
    await expect.poll(() => requested).toEqual([httpsUrl]);
    await expect(dialog(page).locator('.avatar')).toHaveCount(4);
  });

  test('markdown links must be absolute http(s) or mailto; relative and protocol-relative ones are plain text', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await mockDetails(
      page,
      details({
        description: body(
          '[rel](/api/dashboard) [proto](//evil.example/x) [frag](#top) [ok](https://example.org/x) [mail](mailto:a@example.org)',
        ),
      }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const content = dialog(page).locator('.details-body .markdown').first();
    await expect(content.getByRole('link', { name: 'ok' })).toBeVisible();
    await expect(content.getByRole('link')).toHaveCount(2);
    await expect(content).toContainText('rel');
    await expect(content).toContainText('proto');
    await expect(content).toContainText('frag');
    await expect(content.locator('a[href^="/"], a[href^="#"]')).toHaveCount(0);
  });

  test('the row Details button is at least 24px high on a desktop and 44px on a phone', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await page.goto('/pull-requests.html');
    const box = await trigger(page).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
    expect(box?.width).toBeGreaterThanOrEqual(24);
  });

  test('the header shows status chips from the row data, and the version on Releases', async ({
    page,
  }) => {
    await mockDashboard(page, [
      makePR({
        draft: true,
        ci: 'failure',
        mergeStatus: 'conflicting',
        behind: true,
        autoMergeEnabled: true,
        labels: [{ name: 'kind/chore', color: 'cccccc' }],
        kind: 'release',
        title: 'chore(main): release 1.2.0',
      }),
    ]);
    await mockDetails(page, details());
    await page.goto('/releases.html');
    await trigger(page).click();
    const chips = dialog(page).locator('.details-chips');
    for (const text of [
      'Draft',
      'Failing',
      'Conflicts',
      'Out of date',
      'Auto-merge on',
      'kind/chore',
      'v1.2.0',
    ]) {
      await expect(chips.getByText(text, { exact: true })).toBeVisible();
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no axe-core violations with the dialog open (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockDashboard(page, [makePR()]);
      await mockDetails(
        page,
        details({
          description: body('d', {
            reactions: {
              thumbsUp: { count: 2, logins: ['alice', 'bob'] },
              thumbsDown: { count: 1, logins: ['carol'] },
            },
          }),
          comments: [comment('c1'), comment('c2', { author: null })],
          commentCount: 80,
          commentsTruncated: true,
        }),
      );
      await page.goto('/pull-requests.html');
      await trigger(page).click();
      await expect(dialog(page).locator('.details-comment')).toHaveCount(2);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 360]) {
      test(`has no axe-core violations with a reaction list open (${scheme}, ${width}px)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await mockDashboard(page, [makePR()]);
        await mockDetails(
          page,
          details({
            description: body('d', {
              reactions: {
                thumbsUp: { count: 2, logins: ['alice', 'bob'] },
                thumbsDown: { count: 0, logins: [] },
              },
            }),
          }),
        );
        await page.goto('/pull-requests.html');
        await trigger(page).click();
        await dialog(page)
          .getByRole('group', { name: /thumbs up/ })
          .focus();
        await expect(dialog(page).locator('.reaction-people')).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags([
            'wcag2a',
            'wcag2aa',
            'wcag21a',
            'wcag21aa',
            'wcag22aa',
            'best-practice',
          ])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});
