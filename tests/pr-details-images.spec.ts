import { deflateSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// Images embedded in a description load through the server's proxy, and only
// from the item's own forge (#3405). The proxy is mocked: the server side is
// covered by its Go tests.
// Mocks /api/v1/dashboard, /api/v1/pull-requests/details and /api/v1/images.

const reactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};

// A real 2000 x 1000 PNG would be heavy; a 1 x 1 stretched by the browser is
// not the point. This one is 2000 px wide so the width cap is exercised.
function png(width: number, height: number): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height, 0x90);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FORGE_IMAGE = 'https://github.com/user-attachments/assets/wide';
const BROKEN_IMAGE = 'https://github.com/user-attachments/assets/gone';
const TALL_IMAGE = 'https://github.com/user-attachments/assets/tall';
const STRANGER = 'https://tracker.example.net/pixel.png';

async function openDialog(
  page: Page,
  description: string,
  comments: object[] = [],
) {
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
      }),
    }),
  );
  await page.route('**/api/v1/pull-requests/details*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        description: {
          text: description,
          format: 'markdown',
          truncated: false,
          edited: false,
          reactions,
        },
        comments,
        commentCount: comments.length,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
  const asked: string[] = [];
  const askedFor: URLSearchParams[] = [];
  await page.route('**/api/v1/images*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const target = params.get('url') ?? '';
    asked.push(target);
    askedFor.push(params);
    if (target === BROKEN_IMAGE)
      return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: target === TALL_IMAGE ? png(400, 1600) : png(2000, 600),
    });
  });
  const stranger: string[] = [];
  await page.route(/tracker\.example\.net/, (route) => {
    stranger.push(route.request().url());
    return route.abort();
  });
  await page.goto('/pull-requests.html');
  await page
    .locator('#pr-rows .row')
    .first()
    .getByRole('button', { name: /^#\d+ / })
    .click();
  const dialog = page.getByRole('dialog', { name: /^Pull request details/ });
  await expect(dialog).toBeVisible();
  return { dialog, asked, askedFor, stranger };
}

const DESCRIPTION = [
  `![wide mockup](${FORGE_IMAGE})`,
  '',
  `![gone](${BROKEN_IMAGE})`,
  '',
  `![tracker](${STRANGER})`,
].join('\n');

for (const [scheme, width] of [
  ['light', 1280],
  ['dark', 390],
  ['light', 320],
] as const) {
  test(`images show from the item's forge only (${scheme}, ${width}px)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 800 });
    const { dialog, asked, stranger } = await openDialog(page, DESCRIPTION);
    const text = dialog.locator('.details-body .markdown').first();

    // The forge's image is drawn from the server, scaled to fit.
    const image = text.getByRole('img', { name: 'wide mockup' });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute(
      'src',
      /^\/api\/v1\/images\?forge=github&url=/,
    );
    const box = await image.boundingBox();
    const body = await dialog.locator('.details-body').boundingBox();
    expect(box && body && box.width <= body.width).toBe(true);

    // A failed one reads as text, not a broken-image icon.
    await expect(text.getByRole('img', { name: 'gone' })).toHaveCount(0);
    await expect(text).toContainText('Image not available: gone');

    // A stranger's image is never requested, by the page or by us.
    await expect(text.locator('img')).toHaveCount(1);
    await expect(text.getByRole('link', { name: 'tracker' })).toHaveAttribute(
      'href',
      STRANGER,
    );
    expect(stranger).toEqual([]);
    expect(asked).not.toContain(STRANGER);

    // The image rules must not leak into the dialog's own links.
    const readLinks = () =>
      dialog.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--accent)';
        el.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return [...el.querySelectorAll('.details-note a, .ref-link')].map(
          (a) => {
            const cs = getComputedStyle(a);
            return {
              display: cs.display,
              color: cs.color,
              accent,
              border: cs.borderTopWidth,
            };
          },
        );
      });
    await expect
      .poll(async () => (await readLinks()).length)
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        (await readLinks()).filter(
          (link) =>
            link.display === 'block' ||
            link.border !== '0px' ||
            link.color !== link.accent,
        ),
      )
      .toEqual([]);

    const overflow = await dialog.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(overflow).toBe(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

for (const width of [360, 390, 1280]) {
  test(`an image in a comment names that comment to the server (${width}px, #3676)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const { dialog, askedFor } = await openDialog(
      page,
      `![in the description](${FORGE_IMAGE})`,
      [
        {
          id: '4242',
          author: { login: 'ryankes', avatarUrl: '' },
          createdAt: '2026-10-01T10:00:00Z',
          updatedAt: null,
          edited: false,
          text: `![in a comment](${FORGE_IMAGE}-2)`,
          format: 'markdown',
          truncated: false,
          reactions,
        },
      ],
    );

    await expect(
      dialog.getByRole('img', { name: 'in a comment' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('img', { name: 'in the description' }),
    ).toBeVisible();
    const byUrl = (url: string) =>
      askedFor.find((p) => p.get('url') === url) as URLSearchParams;
    expect(byUrl(`${FORGE_IMAGE}-2`).get('comment')).toBe('4242');
    expect(byUrl(FORGE_IMAGE).has('comment')).toBe(false);
    expect(byUrl(FORGE_IMAGE).get('number')).toBe('42');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

// The in-dialog viewer (#3414) and the height cap with a loading skeleton
// (#3468).
for (const [width, height] of [
  [390, 800],
  [1280, 800],
] as const) {
  test(`an image opens in a lightbox and closes with focus back (${width}px, #3414)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const { dialog } = await openDialog(page, `![wide mockup](${FORGE_IMAGE})`);
    const opener = dialog.getByRole('link', { name: 'wide mockup' });
    await expect(opener.getByRole('img')).toBeVisible();
    await opener.focus();
    const popup = page
      .waitForEvent('popup', { timeout: 500 })
      .catch(() => null);
    await page.keyboard.press('Enter');
    expect(await popup).toBeNull();

    const lightbox = page.getByRole('dialog', { name: 'wide mockup' });
    await expect(lightbox).toBeVisible();
    const close = lightbox.getByRole('button', { name: 'Close' });
    const original = lightbox.getByRole('link', {
      name: 'Open original in new tab',
    });
    await expect(original).toHaveAttribute('target', '_blank');
    await expect(original).toHaveAttribute(
      'href',
      /^\/api\/v1\/images\?forge=github&url=/,
    );
    const closeBox = await close.boundingBox();
    expect(closeBox && closeBox.width >= 44 && closeBox.height >= 44).toBe(
      true,
    );

    // Nothing sideways, the image contained.
    const overflow = await lightbox.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(overflow).toBe(0);
    const img = lightbox.getByRole('img', { name: 'wide mockup' });
    const imgBox = await img.boundingBox();
    expect(imgBox && imgBox.width <= width).toBe(true);

    // Page behind is inert and does not scroll.
    expect(
      await page.evaluate(() =>
        document.querySelector('dialog.image-lightbox')?.matches(':modal'),
      ),
    ).toBe(true);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // Focus trap: Tab cycles through the lightbox's own controls only.
    const inside = () =>
      lightbox.evaluate((el) => el.contains(document.activeElement));
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await inside()).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside()).toBe(true);
    }

    // Escape closes only the lightbox, and focus goes back to the image.
    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(opener).toBeFocused();

    // The Close button does the same.
    await opener.click();
    await expect(lightbox).toBeVisible();
    await lightbox.getByRole('button', { name: 'Close' }).click();
    await expect(lightbox).toBeHidden();
    await expect(opener).toBeFocused();
  });
}

for (const width of [320, 390, 1280]) {
  test(`a tall image is capped and holds its space while loading (${width}px, #3468)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const { dialog } = await openDialog(page, `![tall](${TALL_IMAGE})`);
    const image = dialog.locator('.details-body').getByRole('img', {
      name: 'tall',
    });
    await expect(image).toBeVisible();
    await expect(image).toHaveClass(/md-image-loaded/);
    const box = await image.boundingBox();
    expect(box && box.height <= 480).toBe(true);

    // Before the bytes arrive, the image sits in a skeleton of set height.
    const skeleton = await page.evaluate(() => {
      const img = document.createElement('img');
      img.className = 'md-image';
      const host = document.querySelector('.details-body .markdown');
      host?.append(img);
      const h = img.getBoundingClientRect().height;
      img.remove();
      return h;
    });
    expect(skeleton).toBeGreaterThanOrEqual(120);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
