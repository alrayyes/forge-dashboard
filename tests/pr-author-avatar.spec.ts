import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { proxiedImage, routeImage } from './proxied-image';
import { test } from './server-fixture';

// A pull request row shows the author's avatar left of their name when the
// forge supplied one, and the plain name when it did not.
// https://github.com/alrayyes/forge-dashboard/issues/1913

const AVATAR = 'https://avatars.example.com/u/1';

const PIXEL = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#c0392b"/></svg>',
);

function pr(number: number, title: string, authorAvatarUrl: string) {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    number,
    title,
    url: `https://github.com/alrayyes/app/pull/${number}`,
    author: 'claude',
    authorAvatarUrl,
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - (100 - number) * 1000).toISOString(),
    mergeStatus: 'mergeable',
  };
}

const PRS = [
  pr(1, 'With avatar', AVATAR),
  pr(2, 'No avatar', ''),
  pr(3, 'Plain http avatar', 'http://avatars.example.com/u/3'),
  pr(4, 'Broken avatar', 'https://avatars.example.com/broken'),
];

async function mock(page: Page, prs = PRS) {
  await routeImage(page, 'https://avatars.example.com/u/1', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PIXEL }),
  );
  await routeImage(page, 'https://avatars.example.com/broken', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard/stream*', (route: Route) =>
    route.abort(),
  );
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [forgeHealth('github')],
        pullRequests: prs,
        issues: [],
        openIssueCount: 0,
        repos: [],
        hiddenDrafts: 0,
      }),
    }),
  );
}

async function open(page: Page) {
  await mock(page);
  await page.goto('/pull-requests.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

const author = (page: Page, title: string) =>
  page.locator('#pr-rows > .row', { hasText: title }).locator('.author');

test.describe('Pull request row author avatar (#1913)', () => {
  test('shows the forge avatar next to the name', async ({ page }) => {
    await open(page);
    const cell = author(page, 'With avatar');
    await expect(cell.locator('img')).toHaveAttribute(
      'src',
      proxiedImage(AVATAR),
    );
    await expect(cell).toContainText('claude');
  });

  test('the avatar is decorative, the name already says who', async ({
    page,
  }) => {
    await open(page);
    await expect(author(page, 'With avatar').locator('img')).toHaveAttribute(
      'alt',
      '',
    );
  });

  test('the narrow layout drops the whole author cell, avatar included', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await open(page);
    await expect(author(page, 'With avatar')).toBeHidden();
  });

  test('rows with avatars have no accessibility violations', async ({
    page,
  }) => {
    await open(page);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('no avatar draws the initial on a circle and the name once', async ({
    page,
  }) => {
    await open(page);
    const cell = author(page, 'No avatar');
    await expect(cell).toHaveText('claude');
    await expect(cell.locator('img')).toHaveCount(0);
    const placeholder = cell.locator('.avatar-placeholder');
    await expect(placeholder).toHaveCount(1);
    await expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    // Retries until the stylesheet has sized and drawn the placeholder.
    await expect
      .poll(async () => {
        const box = await placeholder.boundingBox();
        return [box?.width, box?.height];
      })
      .toEqual([20, 20]);
    await expect
      .poll(() =>
        placeholder.evaluate((el) => getComputedStyle(el, '::before').content),
      )
      .toBe('"C"');
  });

  test('every author name starts at the same x with or without an avatar (#3868)', async ({
    page,
  }) => {
    await open(page);
    const xs: number[] = [];
    for (const title of [
      'With avatar',
      'No avatar',
      'Plain http avatar',
      'Broken avatar',
    ]) {
      const box = await author(page, title)
        .locator('.author-name')
        .boundingBox();
      xs.push(Math.round(box?.x ?? -1));
    }
    expect(new Set(xs).size).toBe(1);
    expect(xs[0]).toBeGreaterThan(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the placeholder initial has 4.5:1 contrast in ${theme} mode (#3868)`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await open(page);
      const placeholder = author(page, 'No avatar').locator(
        '.avatar-placeholder',
      );
      const lum = (css: string) => {
        const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
          const c = Number(v) / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      // Retries until the stylesheet has painted both colours.
      await expect
        .poll(async () => {
          const [fg, bg] = await placeholder.evaluate((el) => [
            getComputedStyle(el, '::before').color,
            getComputedStyle(el).backgroundColor,
          ]);
          const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
          return (hi + 0.05) / (lo + 0.05);
        })
        .toBeGreaterThanOrEqual(4.5);
    });
  }

  test('an http avatar is never loaded', async ({ page }) => {
    await open(page);
    await expect(author(page, 'Plain http avatar').locator('img')).toHaveCount(
      0,
    );
    await expect(
      author(page, 'Plain http avatar').locator('.avatar-placeholder'),
    ).toHaveCount(1);
  });

  test('an avatar that fails to load swaps to the placeholder in place', async ({
    page,
  }) => {
    await open(page);
    const cell = author(page, 'Broken avatar');
    await expect(cell.locator('img')).toHaveCount(0);
    await expect(cell.locator('.avatar-placeholder')).toHaveCount(1);
    await expect(cell).toHaveText('claude');
  });
});

// The initial is drawn under the picture, and a failed address is left alone
// for a while, so a redrawn row never shows an empty box.
// https://github.com/alrayyes/forge-dashboard/issues/5124
test.describe('Author avatar that cannot load (#5124)', () => {
  const GONE = 'https://avatars.example.com/gone';

  // One row whose avatar is answered by `answer`; returns the requests made.
  async function openOne(page: Page, answer: (route: Route) => unknown) {
    const requested: string[] = [];
    await mock(page, [pr(1, 'Gone avatar', GONE), pr(2, 'No avatar', '')]);
    await routeImage(page, GONE, (route: Route) => {
      requested.push(route.request().url());
      return answer(route);
    });
    // Not the load event: one test never answers the image.
    await page.goto('/pull-requests.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#pr-rows > .row')).toHaveCount(2);
    return requested;
  }

  // Changing the sort rebuilds every row; the mark proves this one is new.
  // Returns how many author images the rebuild put on the page.
  async function redraw(page: Page) {
    const list = page.locator('#pr-rows');
    await list.evaluate((el) => {
      el.querySelector('.row')?.setAttribute('data-before-redraw', '');
      el.dataset.imagesAdded = '0';
      new MutationObserver((records) => {
        for (const node of records.flatMap((r) => [...r.addedNodes])) {
          if (!(node instanceof Element)) continue;
          const added =
            node.querySelectorAll('.author img').length +
            (node.matches('.author img') ? 1 : 0);
          el.dataset.imagesAdded = String(
            Number(el.dataset.imagesAdded) + added,
          );
        }
      }).observe(el, { childList: true, subtree: true });
    });
    await page.getByLabel('Sort pull requests by').selectOption('created');
    await expect(list.locator('[data-before-redraw]')).toHaveCount(0);
    await expect(list.locator('.row')).toHaveCount(2);
    return Number(await list.getAttribute('data-images-added'));
  }

  const picture = (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PIXEL });
  const cell = (page: Page) => author(page, 'Gone avatar');
  const initial = (page: Page) => cell(page).locator('.avatar-placeholder');
  const drawn = (page: Page) =>
    initial(page).evaluate((el) => getComputedStyle(el, '::before').content);

  test('the initial is there while the image is still on its way', async ({
    page,
  }) => {
    await openOne(page, () => {});
    await expect(cell(page).locator('img')).toHaveCount(1);
    await expect(initial(page)).toHaveCount(1);
    await expect.poll(() => drawn(page)).toBe('"C"');
  });

  test('a redrawn row shows the initial and does not ask again', async ({
    page,
  }) => {
    const requested = await openOne(page, (route) =>
      route.fulfill({ status: 404 }),
    );
    await expect.poll(() => requested.length).toBe(1);
    await expect(cell(page).locator('img')).toHaveCount(0);
    expect(await redraw(page)).toBe(0);
    await expect.poll(() => drawn(page)).toBe('"C"');
    expect(requested).toHaveLength(1);
  });

  test('a passing failure is tried again later, without a reload', async ({
    page,
  }) => {
    await page.clock.install();
    const proxy = { busy: true };
    const requested = await openOne(page, (route) =>
      proxy.busy ? route.fulfill({ status: 503 }) : picture(route),
    );
    await expect.poll(() => requested.length).toBe(1);
    await expect(cell(page).locator('img')).toHaveCount(0);
    proxy.busy = false;
    await page.clock.fastForward('02:00');
    expect(await redraw(page)).toBe(1);
    await expect.poll(() => requested.length).toBe(2);
    await expect(initial(page)).toHaveClass(/has-picture/);
  });

  test('a loaded avatar covers the initial in the same box', async ({
    page,
  }) => {
    await openOne(page, picture);
    const img = cell(page).locator('img');
    await expect(initial(page)).toHaveClass(/has-picture/);
    await expect(img).toHaveAttribute('alt', '');
    await expect
      .poll(() =>
        initial(page).evaluate((el) => getComputedStyle(el, '::before').color),
      )
      .toBe('rgba(0, 0, 0, 0)');
    const box = await initial(page).boundingBox();
    expect([box?.width, box?.height]).toEqual([20, 20]);
    expect(await img.boundingBox()).toEqual(box);
  });
});
