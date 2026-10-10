import { expect } from '@playwright/test';
import { STORAGE_STATE_PATH as ADMIN_STORAGE_STATE } from './admin-global-setup';
import { test } from './fixtures';

// #1109: settings was 640px, admin 760px and the other narrow pages 720px,
// so the content jumped sideways moving between them. One width for the
// narrow pages; the dashboard and issues stay full width.
const NARROW_PAGES = [
  { path: '/settings.html', wrap: '.settings-wrap' },
  { path: '/admin.html', wrap: '.admin-wrap' },
  { path: '/webhooks.html', wrap: '.webhooks-wrap' },
  { path: '/insights.html', wrap: '.insights-wrap' },
  { path: '/changelog.html', wrap: '.changelog-wrap' },
  { path: '/disclaimer.html', wrap: '.legal-wrap' },
  { path: '/privacy.html', wrap: '.legal-wrap' },
];

test.describe('narrow pages share one width (#1109)', () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test('every narrow page is 720px wide on a wide screen', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const widths: Record<string, number> = {};
    for (const { path, wrap } of NARROW_PAGES) {
      await page.goto(path);
      const box = await page.locator(wrap).first().boundingBox();
      widths[path] = Math.round(box?.width ?? 0);
    }
    expect(widths).toEqual(
      Object.fromEntries(NARROW_PAGES.map(({ path }) => [path, 720])),
    );
  });
});
