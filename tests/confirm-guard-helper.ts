import type { Page } from '@playwright/test';
import { CONFIRM_GUARD_MS } from '../web/src/lib/confirm-arm';

// An armed confirm ignores a press this soon after it appears, as the tail of
// a double-click. Wait that window out, then press once: retrying a press that
// changes state could send a second one to whatever holds the focus by then.
//
// The guard is a plain time window with no mark in the DOM, so there is nothing
// to wait on but the time. The wait starts after the confirm is already drawn
// and focused, so it always outlasts a guard that began when it was armed, on a
// loaded runner too: load only makes the wait longer. The constant comes from
// the app so the two cannot drift apart.
export async function waitOutConfirmGuard(page: Page) {
  await page.waitForTimeout(CONFIRM_GUARD_MS + 100);
}
