import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/3262
//
// The brand link, chips and a few buttons draw the 2px accent ring; footer
// links, selects, checkboxes and the Settings controls fell back to the browser
// default (`outline: auto 1px`). Tab across both pages and check every stop.

type Stop = { tag: string; id: string; cls: string; ring: string };

async function tabStops(page: Page, max: number): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id,
        cls: String(el.getAttribute('class') ?? ''),
        ring: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
      };
    });
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}

for (const scheme of ['light', 'dark'] as const) {
  for (const path of ['/issues.html', '/settings.html#connections']) {
    test(`every Tab stop on ${path} shows the accent ring in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const accent = await page.evaluate(() => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--accent)';
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      const stops = await tabStops(page, 80);
      expect(stops.length).toBeGreaterThan(5);
      const bad = stops.filter((s) => s.ring !== `solid 2px ${accent}`);
      expect(bad).toEqual([]);
    });
  }
}
