import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { routeImage } from './proxied-image';
import { test } from './server-fixture';
import { settle } from './settle-helper';

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
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests,
        issues: [],
      }),
    }),
  );
}

async function mockDetails(page: Page, payload: unknown, status = 200) {
  const urls: string[] = [];
  await page.route('**/api/v1/pull-requests/details*', (route: Route) => {
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
    .getByRole('button', { name: /^#\d+ / });
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

  // The release pull request's description opens with :robot: (#1995).
  test(`shows emoji shortcodes as emoji in light and dark mode, with no axe violations`, async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(`${scheme}`, async () => {
        await page.emulateMedia({ colorScheme: scheme });

        await mockDashboard(page, [makePR()]);

        await mockDetails(
          page,
          details({
            description: body(':robot: I have created a release *beep* *boop*'),
            comments: [
              {
                id: 'c1',
                author: { login: 'alice', avatarUrl: '' },
                createdAt: ago(30),
                updatedAt: null,
                edited: false,
                text: 'Ship it :tada: at 10:30:45 `:robot:`',
                format: 'markdown',
                truncated: false,
                reactions: noReactions,
              },
            ],
            commentCount: 1,
          }),
        );

        await page.goto('/pull-requests.html');

        await trigger(page).click();

        await expect(dialog(page)).toContainText(
          '🤖 I have created a release beep boop',
        );

        await expect(dialog(page)).not.toContainText(':robot: I have');

        await expect(dialog(page)).toContainText('Ship it 🎉 at 10:30:45');

        await expect(dialog(page).locator('code')).toHaveText(':robot:');

        await expect(dialog(page).locator('img[alt*="robot" i]')).toHaveCount(
          0,
        );

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        expect(results.violations).toEqual([]);
      });
    }
  });

  // The header names the repository and the item as two links, and #N in
  // running text links to the item on the same forge. Each forge keeps its
  // own address scheme.
  test(`links the repository, the number and #N references to the forge in light and dark mode, with no axe violations`, async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(`${scheme}`, async () => {
        await page.emulateMedia({ colorScheme: scheme });

        await mockDashboard(page, [
          makePR({
            url: 'https://github.com/alrayyes/forge-dashboard/pull/42',
          }),
        ]);

        await mockDetails(
          page,
          details({
            description: body(
              'Closes #1859, see other/repo#12 and `#7` or abc#5.',
            ),
          }),
        );

        await page.goto('/pull-requests.html');

        await trigger(page).click();

        const header = dialog(page).locator('.details-ref');

        await expect(
          header.getByRole('link', { name: /^alrayyes\/forge-dashboard/ }),
        ).toHaveAttribute(
          'href',
          'https://github.com/alrayyes/forge-dashboard',
        );

        // The number is plain text, not a forge link (#3744): "Open on
        // <forge>" in the footer is the way there.
        await expect(header.getByRole('link')).toHaveCount(1);
        await expect(header).toContainText('#42');

        const text = dialog(page).locator('.markdown').first();

        // A repository the dashboard tracks opens in place: a real link to
        // the dashboard's own address (#3744). One it doesn't track goes to
        // the forge.
        await expect(text.getByRole('link', { name: '#1859' })).toHaveAttribute(
          'href',
          '/issues.html?issue=github/alrayyes/forge-dashboard/1859',
        );

        await expect(
          text.getByRole('link', { name: /^other\/repo#12/ }),
        ).toHaveAttribute('href', 'https://github.com/other/repo/issues/12');

        await expect(text.getByRole('link')).toHaveCount(2);

        await expect(text.locator('code')).toHaveText('#7');

        await expect(text).toContainText('abc#5.');

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        expect(results.violations).toEqual([]);
      });
    }
  });

  // The links wrap with a long repository name, stay out of each other's way
  // and are 44px targets on a phone, with a cue other than colour.
  test(`keeps the header links usable at 390px in light and dark mode, with no axe violations`, async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(`${scheme}`, async () => {
        await page.setViewportSize({ width: 390, height: 780 });

        await page.emulateMedia({ colorScheme: scheme });

        const repo = `some-organisation-with-a-long-name/${'a-very-long-repository-name-'.repeat(2)}end`;

        await mockDashboard(page, [
          makePR({
            repo,
            url: `https://github.com/${repo}/pull/42`,
          }),
        ]);

        await mockDetails(page, details());

        await page.goto('/pull-requests.html');

        await trigger(page).click();

        const d = dialog(page);

        const links = d.locator('.details-ref').getByRole('link');

        await expect(links).toHaveCount(1);

        await expect
          .poll(async () => {
            const b = await links.first().boundingBox();
            return {
              tall: (b?.height ?? 0) >= 44,
              wide: (b?.width ?? 0) >= 44,
              inside: (b?.x ?? 0) + (b?.width ?? 0) <= 390,
            };
          })
          .toEqual({ tall: true, wide: true, inside: true });

        await expect(links.first()).toHaveCSS(
          'text-decoration-line',
          'underline',
        );

        await expect
          .poll(() => d.evaluate((el) => el.scrollWidth - el.clientWidth))
          .toBe(0);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        expect(results.violations).toEqual([]);
      });
    }
  });

  test('builds the same links from a Forgejo address', async ({ page }) => {
    await mockDashboard(page, [
      makePR({
        forge: 'forgejo',
        repo: 'me/app',
        url: 'https://git.example.org/me/app/pulls/42',
      }),
    ]);
    await mockDetails(page, details({ description: body('Fixes #7') }));
    await page.goto('/pull-requests.html');

    await trigger(page).click();
    await expect(
      dialog(page)
        .locator('.details-ref')
        .getByRole('link', { name: /^me\/app/ }),
    ).toHaveAttribute('href', 'https://git.example.org/me/app');
    await expect(
      dialog(page).getByRole('link', { name: '#7' }),
    ).toHaveAttribute('href', '/issues.html?issue=forgejo/me/app/7');
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
    await page.route('**/api/v1/pull-requests/details*', async (route) => {
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
    await routeImage(page, 'https://example.invalid/**', (route) =>
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
    await expect
      .poll(async () => {
        const box = await img.boundingBox();
        return [box?.width, box?.height];
      })
      .toEqual([32, 32]);
    // No avatar for a deleted account: an initial in a circle.
    await expect(items.nth(1).locator('.avatar')).toHaveText('?');
  });

  test('an avatar that fails to load falls back to an initial', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    let aborted = 0;
    await routeImage(page, 'https://example.invalid/**', (route) => {
      aborted++;
      return route.abort();
    });
    await mockDetails(
      page,
      details({ comments: [comment('c1')], commentCount: 1 }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const avatar = dialog(page).locator('.details-comment .avatar').first();
    await expect(avatar).toHaveText('A');
    // The fallback only means something if the image was asked for and failed.
    expect(aborted).toBeGreaterThan(0);
    await expect(dialog(page).locator('img.avatar')).toHaveCount(0);

    // Opening it again shortly after doesn't ask again (#5124).
    const asked = aborted;
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await trigger(page).click();
    await expect(avatar).toHaveText('A');
    await expect(dialog(page).locator('img.avatar')).toHaveCount(0);
    expect(aborted).toBe(asked);
  });

  test('a comment avatar on its way has its initial under it (#5124)', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await routeImage(page, 'https://example.invalid/**', () => {});
    await mockDetails(
      page,
      details({ comments: [comment('c1')], commentCount: 1 }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const comments = dialog(page).locator('.details-comment');
    await expect(comments.locator('img.avatar')).toHaveCount(1);
    await expect(comments.locator('span.avatar')).toHaveText('A');
    // Not part of a copied comment, as on the rows (#5124).
    await expect(comments.locator('span.avatar')).toHaveCSS(
      'user-select',
      'none',
    );
  });

  const png = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(PNG_1X1, 'base64'),
    });

  test('a loaded comment avatar still covers its initial on reopening (#5124)', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await routeImage(page, 'https://example.invalid/**', png);
    await mockDetails(
      page,
      details({ comments: [comment('c1')], commentCount: 1 }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const avatar = dialog(page).locator('.details-comment span.avatar');
    await expect(avatar).toHaveClass(/has-picture/);

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await trigger(page).click();
    await expect(dialog(page).getByText('Comment c1')).toBeVisible();
    await expect(avatar).toHaveClass(/has-picture/);
  });

  test('a comment avatar whose address changes and then fails shows its initial (#5124)', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await routeImage(page, 'https://example.invalid/**', (route) =>
      route.request().url().includes('gone') ? route.abort() : png(route),
    );
    await mockDetails(
      page,
      details({ comments: [comment('c1')], commentCount: 1 }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const avatar = dialog(page).locator('.details-comment span.avatar');
    await expect(avatar).toHaveClass(/has-picture/);

    await page.keyboard.press('Escape');
    // The same comment, with a new picture.
    await page.unroute('**/api/v1/pull-requests/details*');
    const changed = { ...comment('gone'), id: 'c1' };
    await mockDetails(page, details({ comments: [changed], commentCount: 1 }));
    await trigger(page).click();
    await expect(dialog(page).getByText('Comment gone')).toBeVisible();
    await expect(dialog(page).locator('img.avatar')).toHaveCount(0);
    await expect(avatar).not.toHaveClass(/has-picture/);
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

  test('a rate-limited error says when the limit resets and Try again fetches again, with no axe violations', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    let calls = 0;
    await page.route('**/api/v1/pull-requests/details*', (route) => {
      calls++;
      // Limited on the first read, and again once the details have been shown.
      if (calls !== 2) {
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'github: graphql: rate limit exceeded',
            resetsAt: new Date(Date.now() + 12 * 60_000).toISOString(),
          }),
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
      /GitHub API rate limit reached\. It resets at .+ \(in 1[12] min\)\./,
    );
    for (const width of [390, 1280]) {
      await test.step(`at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
        const box = await dialog(page).getByRole('alert').boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      });
    }
    await dialog(page).getByRole('button', { name: 'Try again' }).click();
    await expect(dialog(page).locator('strong')).toHaveText('structured');
    expect(calls).toBe(2);

    // Reopened: the remembered details stay, and the note says the same.
    await page.keyboard.press('Escape');
    await trigger(page).click();
    await expect(
      dialog(page).getByText(
        /may be out of date.+GitHub API rate limit reached\. It resets at/,
      ),
    ).toBeVisible();
    await expect(dialog(page).locator('strong')).toHaveText('structured');
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
    await page.route('**/api/v1/pull-requests/details*', async (route) => {
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
      .getByRole('button', { name: /^#\d+ / })
      .click();
    await page.keyboard.press('Escape');
    await page
      .locator('#pr-rows .row')
      .nth(1)
      .getByRole('button', { name: /^#\d+ / })
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

  // https://github.com/alrayyes/forge-dashboard/issues/3668
  test('HTML comments in a description are hidden, code keeps its text, with no axe violations', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    const text = [
      '- [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box',
      '',
      '<!--',
      'a multi-line',
      'marker',
      '-->',
      '',
      'Inline `<!-- kept in code -->` stays.',
      '',
      '```html',
      '<!-- kept in fence -->',
      '```',
      '',
      `<!--renovate-debug:${'eyJjcmVhdGVkSW5WZXIiOiIxIn0='.repeat(6)}-->`,
    ].join('\n');
    await mockDetails(page, details({ description: body(text) }));
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const content = dialog(page).locator('.details-body .markdown').first();
    await expect(
      content.getByRole('checkbox', {
        name: 'If you want to rebase/retry this PR, check this box',
      }),
    ).toBeVisible();
    await expect(content).not.toContainText('rebase-check');
    await expect(content).not.toContainText('renovate-debug');
    await expect(content).not.toContainText('multi-line');
    await expect(content).not.toContainText('<!--renovate');
    await expect(content.locator('code').first()).toHaveText(
      '<!-- kept in code -->',
    );
    await expect(content.locator('pre')).toContainText(
      '<!-- kept in fence -->',
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
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
    // The trigger's hit area is the whole row (its stretched overlay).
    await expect
      .poll(async () => {
        const rowBox = await page
          .locator('#pr-rows .row')
          .first()
          .boundingBox();
        return rowBox?.height ?? 0;
      })
      .toBeGreaterThanOrEqual(44);
    await trigger(page).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect
      .poll(async () => {
        const box = await d.boundingBox();
        return [box?.width, box?.height];
      })
      .toEqual([360, 740]);
    await expect
      .poll(() =>
        d.evaluate((el) => {
          const body = el.querySelector('.details-body') as HTMLElement;
          return [
            el.scrollWidth - el.clientWidth,
            body.scrollWidth - body.clientWidth,
          ];
        }),
      )
      .toEqual([0, 0]);
    for (const control of [
      d.getByRole('button', { name: 'Close details' }),
      d.getByRole('link', { name: /Open on GitHub/ }),
    ]) {
      await expect
        .poll(async () => {
          const b = await control.boundingBox();
          return [(b?.height ?? 0) >= 44, (b?.width ?? 0) >= 44];
        })
        .toEqual([true, true]);
    }
  });

  test('a code block in the description takes keyboard focus and shows an outline', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await mockDetails(
      page,
      details({
        description: body('```\n' + 'x'.repeat(300) + '\n```'),
      }),
    );
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    const pre = dialog(page).locator('.markdown pre');
    await expect(pre).toHaveAttribute('tabindex', '0');
    await pre.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(pre).toBeFocused();
    await expect(pre).toHaveCSS('outline-style', 'solid');
    await expect(pre).toHaveCSS('outline-width', '2px');
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
    await page.route('**/api/v1/pull-requests/details*', (route) =>
      route.abort(),
    );
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
    let answered = 0;
    await routeImage(page, 'https://example.invalid/**', (route) => {
      answered++;
      return route.abort();
    });
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
      const u = new URL(r.url());
      if (u.pathname !== '/api/v1/images') return;
      const target = u.searchParams.get('url') ?? '';
      if (target.includes('example.invalid')) requested.push(target);
    });
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    await expect(dialog(page).locator('.details-comment')).toHaveCount(4);
    // Only the https one is ever requested (it fails to load here, which also
    // falls back to the initial, so all four end as initials).
    await expect.poll(() => requested).toContain(httpsUrl);
    await expect.poll(() => answered).toBe(1);
    await expect(dialog(page).locator('.avatar')).toHaveCount(4);
    // Settled: a request that arrives after the https one would still be
    // caught here, where the poll above has already passed.
    await page.waitForTimeout(500);
    expect(requested).toEqual([httpsUrl]);
  });

  test('markdown links must be absolute http(s) or mailto; relative and protocol-relative ones are plain text', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR()]);
    await mockDetails(
      page,
      details({
        description: body(
          '[rel](/api/v1/dashboard) [proto](//evil.example/x) [frag](#top) [ok](https://example.org/x) [mail](mailto:a@example.org)',
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

  test('the header shows attributes from the row data, and the version on Releases', async ({
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
    const status = dialog(page).locator('.details-status');
    const attributes = dialog(page).locator('.attr-cluster');
    for (const text of ['Draft', 'Auto-merge', 'kind/chore', 'v1.2.0']) {
      await expect(
        attributes.locator('.attr-chip', { hasText: text }),
      ).toBeVisible();
    }
    // A confirmed conflict says the pull request is out of date already (#4531).
    await expect(attributes.locator('.attr-chip.behind')).toHaveCount(0);
    // The words are the row's: Failed and Conflicting, never Failing/Conflicts.
    await expect(status.locator('.ci-pill')).toContainText('Failed');
    await expect(status.locator('.merge-pill')).toHaveCount(0);
    await expect(status).not.toContainText('Failing');
  });

  test('a bot pull request carries the bot attribute', async ({ page }) => {
    await mockDashboard(page, [
      makePR({ kind: 'dependency', author: 'dependabot' }),
    ]);
    await mockDetails(page, details());
    await page.goto('/bots.html');
    await trigger(page).click();
    await expect(
      dialog(page).locator('.attr-cluster .attr-chip.bot'),
    ).toHaveText('Bot');
  });

  for (const ci of ['pending', 'failure', 'success'] as const) {
    test(`the CI slot follows the title and reads like the row (${ci})`, async ({
      page,
    }) => {
      await mockDashboard(page, [makePR({ ci, draft: true })]);
      await mockDetails(page, details());
      await page.goto('/pull-requests.html');
      const rowPill = page.locator('#pr-rows .row').first().locator('.ci-pill');
      const rowText = (await rowPill.textContent())?.trim();
      const rowGlyph = await rowPill
        .locator('[data-glyph]')
        .first()
        .getAttribute('data-glyph');
      await trigger(page).click();
      const d = dialog(page);
      const slot = d.locator('.details-status .ci-slot');
      await expect(slot.locator('.ci-pill')).toHaveText(rowText ?? '');
      await expect(slot.locator('[data-glyph]').first()).toHaveAttribute(
        'data-glyph',
        rowGlyph ?? '',
      );
      expect(rowText).toBe(
        { pending: 'Running', failure: 'Failed', success: 'Passed' }[ci],
      );
      // The slot sits under the title, the attributes under the slot.
      await expect
        .poll(async () => {
          const slotBox = await slot.boundingBox();
          const titleBox = await d.locator('.details-title').boundingBox();
          const attrBox = await d.locator('.attr-cluster').boundingBox();
          const titleBottom = (titleBox?.y ?? 0) + (titleBox?.height ?? 0);
          return {
            slotBelowTitle: (slotBox?.y ?? -Infinity) >= titleBottom - 1,
            attrsBelowSlot:
              (attrBox?.y ?? -Infinity) >=
              (slotBox?.y ?? Infinity) + (slotBox?.height ?? 0) - 1,
          };
        })
        .toEqual({ slotBelowTitle: true, attrsBelowSlot: true });
      // A header badge is not a second pipeline button.
      await expect(d.locator('button.ci-pill')).toHaveCount(0);
    });
  }

  test("a pull request with no CI shows the row's No checks badge in the header", async ({
    page,
  }) => {
    await mockDashboard(page, [makePR({ ci: 'none' })]);
    await mockDetails(page, details());
    await page.goto('/pull-requests.html');
    const rowText = (
      await page
        .locator('#pr-rows .row')
        .first()
        .locator('.ci-pill')
        .textContent()
    )?.trim();
    expect(rowText).toBe('No checks');
    await trigger(page).click();
    await expect(dialog(page).locator('.details-status .ci-pill')).toHaveText(
      rowText ?? '',
    );
  });

  test('a mergeable pull request draws no merge pill in the header, like the row', async ({
    page,
  }) => {
    await mockDashboard(page, [makePR({ mergeStatus: 'mergeable' })]);
    await mockDetails(page, details());
    await page.goto('/pull-requests.html');
    await expect(page.locator('#pr-rows .row .merge-pill')).toHaveCount(0);
    await trigger(page).click();
    await expect(dialog(page).locator('.details-status')).toBeVisible();
    await expect(dialog(page).locator('.merge-pill')).toHaveCount(0);
    await expect(dialog(page)).not.toContainText('Mergeable');
  });

  test("a confirmed conflict is the pop-up's status block, with no pill", async ({
    page,
  }) => {
    await mockDashboard(page, [
      makePR({ mergeStatus: 'conflicting', conflictConfirmed: true }),
    ]);
    await mockDetails(page, details());
    await page.goto('/pull-requests.html');
    await trigger(page).click();
    await expect(dialog(page).locator('.merge-pill')).toHaveCount(0);
    await expect(dialog(page)).toContainText('Merge conflict');
  });

  for (const [mergeStatus, ci] of [['blocked', 'success']] as const) {
    test(`the header's merge pill reads like the row's (${mergeStatus})`, async ({
      page,
    }) => {
      await mockDashboard(page, [makePR({ mergeStatus, ci })]);
      await mockDetails(page, details());
      await page.goto('/pull-requests.html');
      const rowPill = page
        .locator('#pr-rows .row')
        .first()
        .locator('.merge-pill');
      const rowText = (await rowPill.textContent())?.trim();
      expect(rowText).toBe(
        mergeStatus === 'blocked' ? 'Blocked' : 'Conflicting',
      );
      await trigger(page).click();
      await expect(
        dialog(page).locator(`.details-status .merge-pill.${mergeStatus}`),
      ).toHaveText(rowText ?? '');
    });
  }

  test('attributes are quiet outlined chips with no fill or state colour', async ({
    page,
  }) => {
    await mockDashboard(page, [
      makePR({
        kind: 'dependency',
        draft: true,
        behind: true,
        autoMergeEnabled: true,
        labels: [{ name: 'kind/chore', color: 'cccccc' }],
      }),
    ]);
    await mockDetails(page, details());
    await page.goto('/bots.html');
    await trigger(page).click();
    const chips = dialog(page).locator('.attr-cluster .attr-chip');
    await expect(chips).toHaveCount(5);
    const quietStyles = () =>
      chips.evaluateAll((els) =>
        els
          .filter((el) => !el.classList.contains('behind'))
          .map((el) => {
            const s = getComputedStyle(el);
            return {
              bg: s.backgroundColor,
              border: s.borderTopWidth,
              color: s.color,
            };
          }),
      );
    // Out of date is the one chip with a fill and the warning colour; the
    // rest stay quiet.
    await expect
      .poll(async () => {
        const quiet = await quietStyles();
        return quiet.map((s) => ({
          bg: s.bg,
          border: s.border,
          sameColour: s.color === quiet[0].color,
        }));
      })
      .toEqual(
        Array.from({ length: 4 }, () => ({
          bg: 'rgba(0, 0, 0, 0)',
          border: '1px',
          sameColour: true,
        })),
      );
  });

  test('on a 360px phone the header status has no overflow, the slot follows the title and the attributes wrap', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await mockDashboard(page, [
      makePR({
        kind: 'dependency',
        ci: 'failure',
        mergeStatus: 'conflicting',
        draft: true,
        behind: true,
        autoMergeEnabled: true,
        labels: [{ name: 'a-rather-long-label-name', color: 'cccccc' }],
      }),
    ]);
    await mockDetails(page, details());
    await page.goto('/bots.html');
    await trigger(page).click();
    const d = dialog(page);
    await expect
      .poll(() =>
        d.evaluate((el) => {
          const header = el.querySelector('.details-header') as HTMLElement;
          return [
            el.scrollWidth - el.clientWidth,
            header.scrollWidth - header.clientWidth,
          ];
        }),
      )
      .toEqual([0, 0]);
    await expect
      .poll(async () => {
        const slot = await d.locator('.details-status .ci-slot').boundingBox();
        const close = await d
          .getByRole('button', { name: 'Close details' })
          .boundingBox();
        const attrs = await d.locator('.attr-cluster').boundingBox();
        const title = await d.locator('.details-title').boundingBox();
        return {
          slotBelowTitle:
            (slot?.y ?? -Infinity) >=
            (title?.y ?? 0) + (title?.height ?? 0) - 1,
          slotLeftAligned: Math.abs((slot?.x ?? 0) - (title?.x ?? 1000)) <= 1,
          slotLeftOfClose:
            (slot?.x ?? 0) + (slot?.width ?? 0) <= (close?.x ?? 0),
          attrsBelowTitle:
            (attrs?.y ?? -Infinity) >
            (title?.y ?? 0) + (title?.height ?? 0) - 1,
          attrsInside: (attrs?.x ?? 0) + (attrs?.width ?? 0) <= 360,
        };
      })
      .toEqual({
        slotBelowTitle: true,
        slotLeftAligned: true,
        slotLeftOfClose: true,
        attrsBelowTitle: true,
        attrsInside: true,
      });
  });

  // The status describes the title, so it comes after it in the DOM and not
  // only on screen (#4405).
  test(`reads repository, title, Status, filer, then the labels, with no axe-core violations (light and dark, phone and desktop)`, async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [375, 1280]) {
        await test.step(`${scheme} ${width}px`, async () => {
          await page.setViewportSize({ width, height: 800 });
          await page.emulateMedia({ colorScheme: scheme });
          await mockDashboard(page, [
            makePR({
              ci: 'failure',
              mergeStatus: 'conflicting',
              labels: [{ name: 'kind/chore', color: 'cccccc' }],
            }),
          ]);
          await mockDetails(page, details());
          await page.goto('/pull-requests.html');
          await trigger(page).click();
          const d = dialog(page);
          await expect(d.locator('.details-status')).toBeVisible();
          // The filer shows once the details name one; a pull request row
          // has none before that, so only what is on screen is compared.
          const order = await d.evaluate((el) => {
            const present = [
              '.details-ref',
              '.details-title',
              '.details-status [role="group"]',
              '.details-author',
              '.details-attributes',
            ]
              .map((sel) => ({ sel, node: el.querySelector(sel) }))
              .filter((p) => p.node !== null);
            return present.map(({ sel }, i) =>
              i === 0 ||
              // biome-ignore lint/style/noNonNullAssertion: filtered above
              present[i - 1]!.node!.compareDocumentPosition(
                // biome-ignore lint/style/noNonNullAssertion: filtered above
                present[i]!.node!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING
                ? sel
                : `${sel} is out of order`,
            );
          });
          expect(order).toEqual([
            '.details-ref',
            '.details-title',
            '.details-status [role="group"]',
            '.details-attributes',
          ]);
          const title = await d.locator('.details-title').boundingBox();
          const status = await d.locator('.details-status').boundingBox();
          expect(status?.y ?? 0).toBeGreaterThanOrEqual(
            (title?.y ?? 0) + (title?.height ?? 0) - 1,
          );
          expect(
            await d.evaluate((el) => el.scrollWidth - el.clientWidth),
          ).toBe(0);
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    }
  });

  test(`has no axe-core violations with the dialog open (light and dark)`, async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await test.step(`${scheme}`, async () => {
        await page.emulateMedia({ colorScheme: scheme });

        await mockDashboard(page, [
          makePR({
            ci: 'failure',
            mergeStatus: 'conflicting',
            kind: 'dependency',
            draft: true,
            behind: true,
            autoMergeEnabled: true,
            labels: [{ name: 'kind/chore', color: 'cccccc' }],
          }),
        ]);

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

        await page.goto('/bots.html');

        await trigger(page).click();

        await expect(dialog(page).locator('.details-comment')).toHaveCount(2);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        expect(results.violations).toEqual([]);
      });
    }
  });
  // A plain-text description that scrolls has nothing inside it to focus, so
  // the box itself must be a tab stop (#3454).
  test(`has no axe-core violations with a long plain-text description (light and dark, every width)`, async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [1280, 320]) {
        await test.step(`${scheme} ${width}px`, async () => {
          await page.setViewportSize({ width, height: 500 });

          await page.emulateMedia({ colorScheme: scheme });

          await mockDashboard(page, [makePR()]);

          await mockDetails(
            page,
            details({
              description: body(
                Array.from(
                  { length: 60 },
                  (_, i) => `Paragraph ${i + 1}.`,
                ).join('\n\n'),
              ),
            }),
          );

          await page.goto('/pull-requests.html');

          await trigger(page).click();

          await expect(dialog(page).locator('.markdown')).toBeVisible();

          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();

          expect(results.violations).toEqual([]);
        });
      }
    }
  });
  test(`has no axe-core violations with a reaction list open (light and dark, every width)`, async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [1280, 360]) {
        await test.step(`${scheme} ${width}px`, async () => {
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
});
