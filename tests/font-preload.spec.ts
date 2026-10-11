import { expect } from '@playwright/test';
import { test } from './fixtures';

// #1255: Lighthouse blamed the footer's layout shifts on the Plex web fonts
// arriving after first paint. A preload link in the page head starts those
// downloads with the HTML, so the swap lands before the page is drawn.
for (const path of ['/login.html', '/disclaimer.html']) {
  test(`${path} preloads the latin fonts its first paint uses`, async ({
    request,
  }) => {
    const res = await request.get(path);
    const html = await res.text();
    const preloads = [
      ...html.matchAll(/<link[^>]*rel="preload"[^>]*as="font"[^>]*>/g),
    ].map((m) => m[0]);

    expect(preloads.length).toBeGreaterThan(0);
    for (const tag of preloads) {
      expect(tag).toContain('type="font/woff2"');
      expect(tag).toContain('crossorigin');
      expect(tag).toMatch(/latin-(400|600)-normal/);
    }
    expect(preloads.some((t) => t.includes('ibm-plex-sans-latin-400'))).toBe(
      true,
    );
    expect(preloads.some((t) => t.includes('ibm-plex-mono-latin-400'))).toBe(
      true,
    );
  });
}
