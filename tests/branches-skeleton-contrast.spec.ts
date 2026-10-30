import { expect, type Page, type Route } from '@playwright/test';
import { test } from './server-fixture';

// The placeholder bars must show against what they sit on at every frame of
// the shimmer, and without it. Branches sits on the same tokens as the list
// pages, so its dimmest frame must be as visible as theirs.
// https://github.com/alrayyes/forge-dashboard/issues/1770

async function hold(page: Page) {
  await page.route('**/api/v1/dashboard/stream*', (r: Route) => r.abort());
  await page.route('**/api/v1/dashboard*', (route: Route) =>
    new URL(route.request().url()).pathname === '/api/v1/dashboard'
      ? new Promise(() => {})
      : route.fallback(),
  );
}

// The lowest contrast between any colour a bar takes (a gradient's stops, or
// its plain fill) and the first opaque background behind it.
async function dimmestContrast(page: Page): Promise<number> {
  return page
    .locator('.skeleton-bar')
    .first()
    .evaluate((bar) => {
      type RGBA = [number, number, number, number];
      const parse = (s: string): RGBA[] =>
        [...s.matchAll(/rgba?\(([^)]+)\)/g)].map((m) => {
          const p = m[1]
            .split(/[ ,/]+/)
            .filter(Boolean)
            .map(Number);
          return [p[0], p[1], p[2], p[3] ?? 1];
        });
      const lum = ([r, g, b]: RGBA) => {
        const f = (v: number) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a: RGBA, b: RGBA) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      let backdrop: RGBA = [255, 255, 255, 1];
      for (let el = bar.parentElement; el; el = el.parentElement) {
        const c = parse(getComputedStyle(el).backgroundColor)[0];
        if (c && c[3] === 1) {
          backdrop = c;
          break;
        }
      }
      const style = getComputedStyle(bar);
      const stops = parse(
        style.backgroundImage !== 'none'
          ? style.backgroundImage
          : style.backgroundColor,
      );
      return Math.min(...stops.map((s) => ratio(s, backdrop)));
    });
}

// Dark with reduced motion is left out: the plain fill was already visible on
// the page background there, so a case for it would guard nothing.
const CASES = [
  ['light', 'no-preference'],
  ['light', 'reduce'],
  ['dark', 'no-preference'],
] as const;

for (const [scheme, motion] of CASES) {
  test(`Branches bars are as visible as the list pages' (${scheme}, motion ${motion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: motion });
    await hold(page);

    await page.goto('/pull-requests.html');
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    const list = await dimmestContrast(page);

    await page.goto('/');
    await expect(page.getByTestId('list-skeleton')).toBeVisible();
    const branches = await dimmestContrast(page);

    expect(list).toBeGreaterThan(1.03);
    expect(branches).toBeGreaterThanOrEqual(list);
  });
}
