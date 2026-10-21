import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// A person's avatar and name are one link to their page on the forge, on the
// rows and in a dialog's comments. The server builds the address; the page
// only checks it is a web address.
// https://github.com/alrayyes/forge-dashboard/issues/1991

const AVATAR = 'https://avatars.example.com/u/1';
const PIXEL = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#c0392b"/></svg>',
);

function pr(number: number, title: string, author: string, authorUrl: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://github.com/alrayyes/app/pull/${number}`,
    author,
    authorAvatarUrl: author === 'claude' ? AVATAR : '',
    authorUrl,
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
  };
}

const PRS = [
  pr(1, 'With avatar', 'claude', 'https://github.com/claude'),
  pr(2, 'Name only', 'ryan', 'https://github.com/ryan'),
  pr(3, 'Deleted account', 'ghost', ''),
  pr(4, 'Unsafe address', 'mallory', 'javascript:alert(1)'),
];

const ISSUES = [
  {
    forge: 'github',
    repo: 'alrayyes/app',
    number: 9,
    title: 'An issue',
    url: 'https://github.com/alrayyes/app/issues/9',
    author: 'claude',
    authorAvatarUrl: AVATAR,
    authorUrl: 'https://github.com/claude',
    housekeeping: false,
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

async function mock(page: Page, issues: object[] = ISSUES) {
  await page.route('https://avatars.example.com/**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PIXEL }),
  );
  await page.route('**/api/dashboard/stream*', (route: Route) => route.abort());
  await page.route('**/api/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues,
        openIssueCount: issues.length,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

// The issue's dialog, opened from its row, with a body and no comments.
async function openIssueDialog(page: Page, issues: object[] = ISSUES) {
  await mock(page, issues);
  await page.route('**/api/issues/details*', (route: Route) => {
    const none = { count: 0, logins: [] };
    const reactions = { thumbsUp: none, thumbsDown: none };

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: 'Body.',
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions,
        },
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
      }),
    });
  });
  await page.goto('/issues.html');
  await page
    .locator('#issue-rows .row')
    .getByRole('button', { name: /^#9 / })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function openPulls(page: Page) {
  await mock(page);
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const author = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title }).locator('.author');

test.describe('Profile links (#1991)', () => {
  test('the author on a row links to their page on the forge, in a new tab', async ({
    page,
  }) => {
    await openPulls(page);
    const link = author(page, 'With avatar').getByRole('link');
    await expect(link).toHaveAttribute('href', 'https://github.com/claude');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('the avatar and the name are one link, not two to the same place', async ({
    page,
  }) => {
    await openPulls(page);
    const cell = author(page, 'With avatar');
    await expect(cell.getByRole('link')).toHaveCount(1);
    await expect(cell.getByRole('link').locator('img')).toHaveCount(1);
    await expect(cell.getByRole('link')).toContainText('claude');
  });

  test("a link's accessible name is the person's name, exactly", async ({
    page,
  }) => {
    await openPulls(page);
    // The visible text is the name (WCAG 2.5.3 label in name), and the avatar
    // is decorative, so nothing else is added to it.
    await expect(
      author(page, 'With avatar').getByRole('link', {
        name: 'claude',
        exact: true,
      }),
    ).toBeVisible();
  });

  test('a person with no avatar is a link on the name alone', async ({
    page,
  }) => {
    await openPulls(page);
    const link = author(page, 'Name only').getByRole('link');
    await expect(link).toHaveText('ryan');
    await expect(link).toHaveAttribute('href', 'https://github.com/ryan');
  });

  test('a deleted account has no link', async ({ page }) => {
    await openPulls(page);
    await expect(author(page, 'Deleted account').getByRole('link')).toHaveCount(
      0,
    );
  });

  test('an address that is not a web address is never a link', async ({
    page,
  }) => {
    await openPulls(page);
    await expect(author(page, 'Unsafe address').getByRole('link')).toHaveCount(
      0,
    );
  });

  test('clicking the author goes to the forge and does not open the row', async ({
    page,
  }) => {
    await openPulls(page);
    await page
      .context()
      .route('https://github.com/**', (route: Route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }),
      );
    const popup = page.waitForEvent('popup');
    await author(page, 'With avatar').getByRole('link').click();
    expect((await popup).url()).toBe('https://github.com/claude');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the link is at least 24px tall', async ({ page }) => {
    await openPulls(page);
    const box = await author(page, 'With avatar')
      .getByRole('link')
      .boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`rows with profile links have no accessibility violations in ${theme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await openPulls(page);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('an issue row links its author too, avatar and name as one link', async ({
    page,
  }) => {
    await mock(page);
    await page.goto('/issues.html');
    const cell = page
      .locator('.row', { hasText: 'An issue' })
      .locator('.author');
    await expect(cell.getByRole('link')).toHaveCount(1);
    await expect(cell.getByRole('link')).toHaveAttribute(
      'href',
      'https://github.com/claude',
    );
    await expect(cell.getByRole('link').locator('img')).toHaveCount(1);
  });

  test("the issue dialog's Filed by is one link on the avatar and the name", async ({
    page,
  }) => {
    await openIssueDialog(page);
    const filedBy = page.getByRole('dialog').locator('.details-author');
    const link = filedBy.getByRole('link', { name: 'claude', exact: true });
    await expect(link).toHaveAttribute('href', 'https://github.com/claude');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link.locator('img')).toHaveCount(1);
    await expect(filedBy.getByRole('link')).toHaveCount(1);
  });

  test("the issue dialog's Filed by link is at least 24px tall", async ({
    page,
  }) => {
    await openIssueDialog(page);
    const box = await page
      .getByRole('dialog')
      .locator('.details-author')
      .getByRole('link')
      .boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
  });

  test('a deleted account in Filed by is plain text, not a link', async ({
    page,
  }) => {
    await openIssueDialog(page, [
      { ...ISSUES[0], author: 'ghost', authorAvatarUrl: '', authorUrl: '' },
    ]);
    const filedBy = page.getByRole('dialog').locator('.details-author');
    await expect(filedBy).toContainText('ghost');
    await expect(filedBy.getByRole('link')).toHaveCount(0);
  });

  test('an address that is not a web address is never a link in Filed by', async ({
    page,
  }) => {
    await openIssueDialog(page, [
      { ...ISSUES[0], authorUrl: 'javascript:alert(1)' },
    ]);
    const filedBy = page.getByRole('dialog').locator('.details-author');
    await expect(filedBy).toContainText('claude');
    await expect(filedBy.getByRole('link')).toHaveCount(0);
  });

  // The existing issue dialog scans run on data with no profile address, so
  // they never see the link; these do.
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      test(`the issue dialog with a Filed by link has no accessibility violations in ${theme} mode at ${width}px`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 800 });
        await openIssueDialog(page);
        await expect(
          page.getByRole('dialog').locator('.details-author').getByRole('link'),
        ).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
});

async function openDialog(page: Page) {
  await page.route('**/api/pull-requests/details*', (route: Route) => {
    const none = { count: 0, logins: [] };
    const reactions = { thumbsUp: none, thumbsDown: none };
    const comment = (id: string, author: object | null, text: string) => ({
      id,
      author,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      edited: false,
      truncated: false,
      text,
      format: 'markdown',
      reactions,
    });

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: 'Body.',
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions,
        },
        comments: [
          comment(
            'c1',
            {
              login: 'alice',
              avatarUrl: AVATAR,
              url: 'https://github.com/alice',
            },
            'Looks good.',
          ),
          comment('c2', null, 'From a deleted account.'),
          comment(
            'c3',
            { login: 'bob', avatarUrl: AVATAR, url: '' },
            'No address for this forge yet.',
          ),
        ],
        commentCount: 3,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    });
  });
  await openPulls(page);
  await page
    .locator('#pr-rows > .row', { hasText: 'With avatar' })
    .getByRole('button', { name: /^#\d+ / })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test.describe('Profile links in the pull request dialog (#1991)', () => {
  test('a commenter is one link to their page', async ({ page }) => {
    await openDialog(page);
    const link = page
      .getByRole('dialog')
      .getByRole('link', { name: 'alice', exact: true });
    await expect(link).toHaveAttribute('href', 'https://github.com/alice');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link.locator('img')).toHaveCount(1);
  });

  test('a deleted account in the dialog is plain text', async ({ page }) => {
    await openDialog(page);
    await expect(
      page.getByRole('dialog').getByRole('link', { name: /^ghost/ }),
    ).toHaveCount(0);
  });

  test('a person with no address yet is shown by name, not as a dead link', async ({
    page,
  }) => {
    await openDialog(page);
    await expect(
      page.getByRole('dialog').getByRole('link', { name: /^bob/ }),
    ).toHaveCount(0);
    await expect(page.getByRole('dialog')).toContainText('bob');
  });

  test('on a phone the commenter link is a 44px target', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openDialog(page);
    const box = await page
      .getByRole('dialog')
      .getByRole('link', { name: 'alice', exact: true })
      .boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the dialog with profile links has no accessibility violations in ${theme} mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 390, height: 800 });
      await openDialog(page);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
