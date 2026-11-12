import { expect } from '@playwright/test';
import { test } from './server-fixture';

// The page marks its own timed reads as background reads, so a forgotten tab
// that keeps polling is not taken for someone using the dashboard. The server's
// side is asserted in the Go tests, and the tab's visible/hidden reports in
// web/src/lib/presence-browser.test.ts; this proves the layout's header.

test('the nav read the page makes on its own timer is marked as a background read', async ({
  page,
}) => {
  const read = page.waitForRequest(
    (req) => new URL(req.url()).pathname === '/api/v1/dashboard',
  );
  await page.goto('/settings.html');
  expect((await read).headers()['x-background-read']).toBe('true');
});
