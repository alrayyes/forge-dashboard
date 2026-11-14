import { expect, type Page } from '@playwright/test';

// A failure's error toast carries the reason, and the row's line for it stays
// out of sight until the toast is gone (#3914). A test that is about the row's
// line (its Retry, Copy or Dismiss) dismisses the toasts first.
export async function dismissToasts(page: Page) {
  const toasts = page.locator('#feedback-toasts .feedback-toast');
  await expect(toasts.first()).toBeVisible();
  while ((await toasts.count()) > 0) {
    await toasts
      .first()
      .getByRole('button', { name: /^Dismiss/ })
      .click();
  }
}
