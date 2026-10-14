import type { Page } from '@playwright/test';

// The page has handled everything already delivered to it: two rendered
// frames later, a handler that was going to change the DOM has done so.
// This is a render flush, not a delay.
export async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
