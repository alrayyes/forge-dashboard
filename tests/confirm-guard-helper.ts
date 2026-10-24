import type { Page } from '@playwright/test';
import { CONFIRM_GUARD_MS } from '../web/src/lib/confirm-arm';

// An armed confirm ignores a press this soon after it appears, as the tail of
// a double-click. Wait that window out, then press once: retrying a press that
// changes state could send a second one to whatever holds the focus by then.
export async function waitOutConfirmGuard(page: Page) {
  await page.waitForTimeout(CONFIRM_GUARD_MS + 100);
}
