import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// The page sends a Content-Security-Policy whose img-src names this server
// alone, and nothing on the dashboard, the details dialog or the settings page
// trips it (#3467). Avatars, logos and embedded images all come through the
// image proxy, which is mocked here; the server side is covered by Go tests.

const AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4';
const LOGO = 'https://repository-images.githubusercontent.com/1/logo';
const EMBEDDED = 'https://github.com/user-attachments/assets/shot';
const STRANGER = 'https://tracker.example.net/pixel.png';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const reactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
}

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

async function mock(page: Page) {
  await page.route('**/api/v1/images*', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  );
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: [
          {
            forge: 'github',
            repo: 'alrayyes/forge-dashboard',
            number: 42,
            title: 'Add structured logging',
            url: 'https://github.com/alrayyes/forge-dashboard/pull/42',
            author: 'ryankes',
            authorAvatarUrl: AVATAR,
            draft: false,
            ci: 'success',
            labels: [],
            createdAt: new Date(Date.now() - 3_600_000).toISOString(),
            updatedAt: new Date().toISOString(),
            mergeStatus: 'mergeable',
            behind: false,
            kind: 'regular',
          },
        ],
        issues: [],
        repos: [
          {
            forge: 'github',
            fullName: 'alrayyes/forge-dashboard',
            url: 'https://github.com/alrayyes/forge-dashboard',
            logoUrl: LOGO,
            hasWebhook: false,
            canManageWebhooks: false,
            ignored: false,
            ignoredPRs: false,
            ignoredIssues: false,
            autoUpdateBranch: false,
          },
        ],
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: `![shot](${EMBEDDED})\n\n![tracker](${STRANGER})\n\n- [x] ticked item`,
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions,
        },
        comments: [
          {
            id: 'c1',
            author: { login: 'alice', avatarUrl: AVATAR, url: '' },
            text: 'Looks good.',
            format: 'markdown',
            createdAt: new Date().toISOString(),
            edited: false,
            truncated: false,
            reactions,
          },
        ],
        commentCount: 1,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
}

test('every response names this server as the only image source', async ({
  page,
}) => {
  for (const path of ['/pull-requests.html', '/settings.html']) {
    const response = await page.goto(path);
    expect(response?.headers()['content-security-policy']).toBe(
      "img-src 'self'",
    );
  }
});

test('a direct image from another host is refused and reported', async ({
  page,
}) => {
  await watchViolations(page);
  await mock(page);
  await page.goto('/pull-requests.html');
  await page.evaluate((src) => {
    const img = document.createElement('img');
    img.src = src;
    document.body.append(img);
  }, STRANGER);
  await expect.poll(() => violations(page)).toHaveLength(1);
  expect((await violations(page))[0]).toContain(STRANGER);
});

test('the dashboard, the details dialog and settings raise no violation', async ({
  page,
}) => {
  await watchViolations(page);
  await mock(page);

  await page.goto('/pull-requests.html');
  const row = page.locator('#pr-rows .row').first();
  await expect(row.locator('img.author-avatar')).toBeVisible();
  await expect(row.locator('img.repo-logo')).toBeVisible();

  await row.getByRole('button', { name: /^#\d+ / }).click();
  const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'shot' })).toBeVisible();
  await expect(dialog.locator('img').nth(1)).toBeVisible();
  // A ticked task box draws its mark without an image.
  await expect(
    dialog.getByRole('checkbox', { name: 'ticked item' }),
  ).toBeChecked();
  expect(await violations(page)).toEqual([]);

  await page.goto('/settings.html');
  await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
