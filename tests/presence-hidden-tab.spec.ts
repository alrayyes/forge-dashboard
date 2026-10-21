import { expect, type Request } from '@playwright/test';
import { landOnPullRequests, test } from './server-fixture';

// A tab says whether it is being looked at, so a forgotten tab does not keep
// the scheduled refresh running. The server's side (what counts, the bounded
// time, the wake) is asserted in the Go tests; this proves the page's wiring:
// it reports visible on load, hidden when the tab is hidden, visible again when
// it comes back, and marks its own timed reads as background reads.

type Report = { viewerId: string; visible: boolean };

const show = (
  page: import('@playwright/test').Page,
  state: 'hidden' | 'visible',
) =>
  page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => v,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

test('a tab reports visible, then hidden, then visible again', async ({
  page,
}) => {
  const reports: Report[] = [];
  page.on('request', (req: Request) => {
    if (req.url().endsWith('/api/presence') && req.method() === 'POST')
      reports.push(req.postDataJSON() as Report);
  });

  await landOnPullRequests(page);
  await expect.poll(() => reports.map((r) => r.visible)).toEqual([true]);
  const viewerId = reports[0].viewerId;

  await show(page, 'hidden');
  await expect.poll(() => reports.map((r) => r.visible)).toEqual([true, false]);

  await show(page, 'visible');
  await expect
    .poll(() => reports.map((r) => r.visible))
    .toEqual([true, false, true]);
  expect(new Set(reports.map((r) => r.viewerId))).toEqual(new Set([viewerId]));
});

test('the nav read the page makes on its own timer is marked as a background read', async ({
  page,
}) => {
  const read = page.waitForRequest(
    (req) => new URL(req.url()).pathname === '/api/dashboard',
  );
  await page.goto('/settings.html');
  expect((await read).headers()['x-background-read']).toBe('true');
});
