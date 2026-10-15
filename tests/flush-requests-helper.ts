import type { Page } from '@playwright/test';

// Every request the page started before this call has reached its route
// handler: a sentinel fetch is queued behind them and answered by a route
// of its own. For a "no request was sent" assertion, this is the proof the
// page had its chance, and it replaces a real-time sleep.
export async function flushRequests(page: Page) {
  await page.route('**/__flush', (route) => route.fulfill({ status: 204 }));
  await page.evaluate(() => fetch('/__flush').then(() => undefined));
}
