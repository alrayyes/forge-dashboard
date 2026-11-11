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
const STRANGER = 'https://tracker.example.net/pixel.png';

async function openDialog(page: Page, description: string) {
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
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        releaseNotes: null,
      }),
    }),
  );
  const asked: string[] = [];
  await page.route('**/api/v1/images*', (route) => {
    const target = new URL(route.request().url()).searchParams.get('url') ?? '';
    asked.push(target);
    if (target === BROKEN_IMAGE)
      return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: png(2000, 600),
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
  return { dialog, asked, stranger };
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
