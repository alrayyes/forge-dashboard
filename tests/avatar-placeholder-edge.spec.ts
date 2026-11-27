import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { pickButton, pickPanel } from './label-filter-helper';
import { routeImage } from './proxied-image';
import { test } from './server-fixture';

// An initial placeholder takes the same box as a picture, but a faint edge on
// a faint fill left only the letter to see, so it read as smaller. Its edge
// has to stand out from what is behind it.
// https://github.com/alrayyes/forge-dashboard/issues/5008

const AVATAR = 'https://avatars.githubusercontent.com/u/1';
const LOGO = 'https://repository-images.githubusercontent.com/1/alice';
const NOW = new Date().toISOString();
const IMAGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c0392b"/></svg>',
);

function pr(number: number, author: string, authorAvatarUrl: string) {
  return {
    forge: 'github',
    repo: `acme/${author}`,
    number,
    title: `Pull request by ${author}`,
    url: `https://github.com/acme/${author}/pull/${number}`,
    author,
    authorAvatarUrl,
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: NOW,
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
  };
}

const PRS = [pr(1, 'alice', AVATAR), pr(2, 'carol', '')];

const repo = (name: string, logoUrl?: string) => ({
  forge: 'github',
  logoUrl,
  fullName: `acme/${name}`,
  url: `https://github.com/acme/${name}`,
  hasWebhook: false,
  canManageWebhooks: false,
  ignored: false,
  ignoredPRs: false,
  ignoredIssues: false,
  autoUpdateBranch: false,
});

function comment(id: string, login: string, avatarUrl: string) {
  return {
    id,
    author: { login, avatarUrl },
    createdAt: NOW,
    updatedAt: null,
    edited: false,
    text: `Comment by ${login}`,
    format: 'markdown',
    truncated: false,
    reactions: {
      thumbsUp: { count: 0, logins: [] },
      thumbsDown: { count: 0, logins: [] },
    },
  };
}

async function mock(page: Page) {
  for (const url of [AVATAR, LOGO]) {
    await routeImage(page, url, (route: Route) =>
      route.fulfill({ status: 200, contentType: 'image/svg+xml', body: IMAGE }),
    );
  }
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: NOW,
        forges: [forgeHealth('github', { repoCount: 2 })],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        repos: [repo('alice', LOGO), repo('carol')],
        hiddenDrafts: 0,
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: 'A change.',
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions: {
            thumbsUp: { count: 0, logins: [] },
            thumbsDown: { count: 0, logins: [] },
          },
        },
        comments: [comment('c1', 'alice', AVATAR), comment('c2', 'carol', '')],
        commentCount: 2,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
}

async function openRows(page: Page) {
  await mock(page);
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const row = (page: Page, author: string) =>
  page.locator('#pr-rows > .row', { hasText: `Pull request by ${author}` });

// WCAG contrast of the element's edge against the first painted background
// behind it. 0 when there is no edge at all.
function edgeContrast(target: Locator) {
  return target.evaluate((el) => {
    const channels = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number);
    const lum = (css: string) => {
      const [r, g, b] = channels(css)
        .slice(0, 3)
        .map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let behind = el.parentElement;
    while (
      behind &&
      channels(getComputedStyle(behind).backgroundColor)[3] === 0
    ) {
      behind = behind.parentElement;
    }
    const style = getComputedStyle(el);
    if (!behind || Number.parseFloat(style.borderTopWidth) < 1) return 0;
    const [hi, lo] = [
      lum(style.borderTopColor),
      lum(getComputedStyle(behind).backgroundColor),
    ].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });
}

// Retries until the stylesheet has painted the edge. 3:1 is the WCAG bar for a
// shape that has to be seen:
// https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
const expectVisibleEdge = (target: Locator) =>
  expect.poll(() => edgeContrast(target)).toBeGreaterThanOrEqual(3);

const choice = (page: Page, key: 'author' | 'repo', name: string) =>
  pickPanel(page, key).locator('.label-filter-option', { hasText: name });

// Which pixels of a screenshot of the element show the picture (IMAGE's red):
// the middle of each side, then the top left corner. A box measurement can't
// tell, since a clipped image keeps its box.
async function picturePaint(page: Page, target: Locator) {
  // Clipped to whole pixels, where the box is painted: an element screenshot
  // of a box at a fraction of a pixel comes out a pixel wider.
  const box = await target.boundingBox();
  if (!box) return null;
  const clip = {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
  const shot = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/png' }),
    );
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext(
      '2d',
    );
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const red = (x: number, y: number) => {
      const [r, g, b] = context.getImageData(x, y, 1, 1).data;
      return Math.abs(r - 192) < 45 && Math.abs(g - 57) < 45 && b < 90;
    };
    const mid = Math.floor(bitmap.width / 2);
    const end = bitmap.width - 1;
    return {
      width: bitmap.width,
      left: red(0, mid),
      right: red(end, mid),
      top: red(mid, 0),
      bottom: red(mid, end),
      corner: red(0, 0),
    };
  }, shot);
}

const FULL_DISC = {
  width: 16,
  left: true,
  right: true,
  top: true,
  bottom: true,
  corner: false,
};

const size = async (target: Locator) => {
  const box = await target.boundingBox();
  return [box?.width, box?.height];
};

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`Initial placeholder edge in ${theme} mode (#5008)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    });

    test('a row placeholder fills the picture box and its edge shows, hovered or not', async ({
      page,
    }) => {
      await openRows(page);
      const picture = row(page, 'alice').locator('img.author-avatar');
      const placeholder = row(page, 'carol').locator('.avatar-placeholder');
      await expect.poll(() => size(picture)).toEqual([20, 20]);
      await expect.poll(() => size(placeholder)).toEqual([20, 20]);
      await expectVisibleEdge(placeholder);
      await row(page, 'carol').hover();
      await expectVisibleEdge(placeholder);
      await expectNoViolations(page);
    });

    test('a comment placeholder in the details dialog has the same edge', async ({
      page,
    }) => {
      await openRows(page);
      await row(page, 'alice')
        .getByRole('button', { name: /^#\d+ / })
        .click();
      const dialog = page.getByRole('dialog', {
        name: /^Pull request details/,
      });
      const picture = dialog.locator('img.avatar');
      // The one with a picture draws its circle too, under the image (#5124).
      const placeholder = dialog.locator('span.avatar:not(:has(img))');
      await expect.poll(() => size(picture)).toEqual([32, 32]);
      await expect.poll(() => size(placeholder)).toEqual([32, 32]);
      await expectVisibleEdge(placeholder);
      await expectNoViolations(page);
    });

    test('a filter choice with no picture has the same edge', async ({
      page,
    }) => {
      await openRows(page);
      for (const [key, name] of [
        ['author', 'carol'],
        ['repo', 'acme/carol'],
      ] as const) {
        await pickButton(page, key).click();
        const image = pickPanel(page, key)
          .locator('.label-filter-option', { hasText: name })
          .locator('.pick-image');
        await expect.poll(() => size(image)).toEqual([16, 16]);
        await expectVisibleEdge(image);
        await expectNoViolations(page);
        await pickButton(page, key).click();
      }
    });

    test('a filter choice paints its picture to the same 16px as a placeholder (#5013)', async ({
      page,
    }) => {
      await openRows(page);
      for (const [key, name] of [
        ['author', 'alice'],
        ['repo', 'acme/alice'],
      ] as const) {
        await pickButton(page, key).click();
        const image = choice(page, key, name).locator('.pick-image');
        // Retries until the picture has loaded and painted. The corner stays
        // unpainted: the avatar is a disc and the logo keeps rounded corners.
        await expect.poll(() => picturePaint(page, image)).toEqual(FULL_DISC);
        await expectNoViolations(page);
        await pickButton(page, key).click();
      }
    });

    test('a picture still loading keeps the placeholder edge', async ({
      page,
    }) => {
      await mock(page);
      // Never answered, so the choice stays in its loading state.
      await routeImage(page, AVATAR, () => {});
      await page.goto('/pull-requests.html', {
        waitUntil: 'domcontentloaded',
      });
      await pickButton(page, 'author').click();
      const image = choice(page, 'author', 'alice').locator('.pick-image');
      await expect(image.locator('img')).toHaveCount(1);
      await expectVisibleEdge(image);
    });

    test('a picture that fails to load leaves the name where it was (#5013)', async ({
      page,
    }) => {
      await mock(page);
      await routeImage(page, AVATAR, (route: Route) => route.abort());
      await page.goto('/pull-requests.html');
      await pickButton(page, 'author').click();
      const failed = choice(page, 'author', 'alice');
      await expect(failed.locator('img')).toHaveCount(0);
      await expectVisibleEdge(failed.locator('.pick-image'));
      const nameX = async (row: Locator) =>
        (await row.locator('.pick-name').boundingBox())?.x;
      expect(await nameX(failed)).toBe(
        await nameX(choice(page, 'author', 'carol')),
      );
    });

    test('a repository logo placeholder on Settings has the same edge', async ({
      page,
    }) => {
      await mock(page);
      await page.goto('/settings.html#repositories');
      const placeholder = page
        .locator('#repositories-rows tr', { hasText: 'acme/carol' })
        .locator('.logo-placeholder');
      await expect.poll(() => size(placeholder)).toEqual([16, 16]);
      await expectVisibleEdge(placeholder);
      await expectNoViolations(page);
    });
  });
}
