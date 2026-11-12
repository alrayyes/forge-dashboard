import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { navCountsFor } from './nav-counts-helper';
import { routeImage } from './proxied-image';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3237
//
// The author link's focus ring was drawn outside the link's box, and its
// parent `.author` has `overflow: hidden`, so the cell clipped it (WCAG 2.2
// SC 2.4.7 Focus Visible). Only a real render can show a paint-level clip, so
// this Tabs to each link, screenshots the link box plus a margin focused and
// blurred, and counts the pixels that changed along each of the four edges.

const AVATAR = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#c0392b"/></svg>',
);

const LONG = 'a-very-long-author-name-that-cannot-fit-in-the-cell';

const CASES = [
  { title: 'short', author: 'al', avatar: false },
  { title: 'long', author: LONG, avatar: false },
  { title: 'shortavatar', author: 'al', avatar: true },
  { title: 'longavatar', author: LONG, avatar: true },
];

function bot(number: number, title: string, author: string, avatar: boolean) {
  return {
    forge: 'github',
    repo: 'alrayyes/forge-dashboard',
    number,
    title: `Bump ${title} from 1.0.0 to 1.0.1`,
    url: `https://example.com/${number}`,
    author,
    authorUrl: `https://github.com/${author}`,
    authorAvatarUrl: avatar ? 'https://avatars.example.com/u/1' : '',
    draft: false,
    ci: 'success',
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    mergeStatus: 'mergeable',
    behind: false,
    kind: 'dependency',
  };
}

const PRS = CASES.map((c, i) => bot(i + 1, c.title, c.author, c.avatar));

async function open(page: Page, width: number, scheme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: scheme });
  await routeImage(page, 'https://avatars.example.com/u/1', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: AVATAR }),
  );
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        forges: [{ forge: 'github', reachable: true, repoCount: 1 }],
        pullRequests: PRS,
        issues: [],
        openIssueCount: 0,
        navCounts: navCountsFor(PRS, 0),
      }),
    }),
  );
  await page.goto('/bots.html');
  await expect(page.locator('#pr-rows > .row')).toHaveCount(PRS.length);
}

// Real keyboard focus, since :focus-visible does not match otherwise.
async function tabTo(page: Page, link: Locator) {
  const handle = await link.elementHandle();
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press('Tab');
    if (await handle?.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error('Tab never reached the author link');
}

const PAD = 4; // CSS px captured outside the link box
const INSET = 2; // CSS px inside the box that count as the edge

// Pixels that differ between two screenshots of the same clip, per edge. Each
// edge is the band from PAD outside the link box to INSET inside it, corners
// left out, so a ring drawn outside or inside the box both register.
async function changedPerEdge(
  page: Page,
  a: Buffer,
  b: Buffer,
  w: number,
  h: number,
) {
  return page.evaluate(
    async ([a64, b64, w, h, pad, inset]) => {
      const load = async (s: string) => {
        const blob = await (await fetch(`data:image/png;base64,${s}`)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      };
      const [ia, ib] = await Promise.all([load(a64), load(b64)]);
      const diff = (x: number, y: number) => {
        const i = (y * ia.width + x) * 4;
        return (
          Math.abs(ia.data[i] - ib.data[i]) +
            Math.abs(ia.data[i + 1] - ib.data[i + 1]) +
            Math.abs(ia.data[i + 2] - ib.data[i + 2]) >
          30
        );
      };
      const count = (x0: number, x1: number, y0: number, y1: number) => {
        let n = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) if (diff(x, y)) n++;
        return n;
      };
      // The box sits at (pad, pad) with size w x h in the clip.
      const l = pad;
      const t = pad;
      const r = pad + w;
      const bt = pad + h;
      return {
        top: count(l + pad, r - pad, t - pad, t + inset),
        bottom: count(l + pad, r - pad, bt - inset, bt + pad),
        left: count(l - pad, l + inset, t + pad, bt - pad),
        right: count(r - inset, r + pad, t + pad, bt - pad),
      };
    },
    [
      a.toString('base64'),
      b.toString('base64'),
      Math.round(w),
      Math.round(h),
      PAD,
      INSET,
    ] as const,
  );
}

test.describe('Author link focus ring (#3237)', () => {
  for (const width of [390, 1280]) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`shows on all four sides at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await open(page, width, scheme);
        for (const c of CASES) {
          const row = page.locator('#pr-rows > .row', {
            hasText: new RegExp(`Bump ${c.title} from`),
          });
          const link = row.locator('.author-link:visible');
          const cell = row.locator('.author:visible');
          await tabTo(page, link);
          await expect(link).toBeFocused();
          expect(
            await link.evaluate((el) => el.matches(':focus-visible')),
          ).toBe(true);
          const box = await link.boundingBox();
          const cellBox = await cell.boundingBox();
          if (!box || !cellBox) throw new Error('no box');
          const clip = {
            x: box.x - PAD,
            y: box.y - PAD,
            width: box.width + PAD * 2,
            height: box.height + PAD * 2,
          };
          const focused = await page.screenshot({ clip });
          await link.evaluate((el) => (el as HTMLElement).blur());
          const blurred = await page.screenshot({ clip });
          // The row must not move when focus leaves.
          expect(await link.boundingBox()).toEqual(box);
          expect(await cell.boundingBox()).toEqual(cellBox);

          const edges = await changedPerEdge(
            page,
            focused,
            blurred,
            box.width,
            box.height,
          );
          const need = (len: number) => Math.max(4, (len - 2 * PAD) / 2);
          const label = `${c.title}: ${JSON.stringify(edges)}`;
          expect(edges.top, label).toBeGreaterThanOrEqual(need(box.width));
          expect(edges.bottom, label).toBeGreaterThanOrEqual(need(box.width));
          expect(edges.left, label).toBeGreaterThanOrEqual(need(box.height));
          expect(edges.right, label).toBeGreaterThanOrEqual(need(box.height));
        }
      });
    }
  }

  test('820px still hides the author cell', async ({ page }) => {
    await open(page, 820, 'light');
    await expect(page.locator('#pr-rows .author').first()).toBeHidden();
  });
});
