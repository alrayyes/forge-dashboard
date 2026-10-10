import { expect } from '@playwright/test';
import { STORAGE_STATE_PATH as ADMIN_STORAGE_STATE } from './admin-global-setup';
import { test } from './fixtures';

// #1109: the settings and admin cards carried tall empty space under their
// content, from empty status lines that kept a minimum height and from empty
// states that borrowed the boards' 28px padding.
const MAX_TRAILING_GAP = 8;

test.describe('settings and admin cards have no tall empty space (#1109)', () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  for (const path of ['/settings.html', '/admin.html']) {
    test(`${path}: nothing but the card's own padding trails the content`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await expect(page.locator('.card').first()).toBeVisible();
      await page.waitForLoadState('networkidle');

      const gaps = await page.$$eval('.card', (cards) =>
        cards.map((card) => {
          const box = card.getBoundingClientRect();
          const padding = Number.parseFloat(
            getComputedStyle(card).paddingBottom,
          );
          let bottom = box.top;
          for (const el of card.querySelectorAll('*')) {
            const rect = el.getBoundingClientRect();
            if (rect.height === 0 || rect.width === 0) continue;
            // An empty state's own padding is the space under its text.
            const style = getComputedStyle(el);
            const inner = el.classList.contains('empty-state')
              ? rect.bottom - Number.parseFloat(style.paddingBottom)
              : rect.bottom;
            bottom = Math.max(bottom, inner);
          }
          return {
            heading: `${card.querySelector('h2')?.textContent ?? card.textContent?.trim().slice(0, 30)} (${card.className})`,
            gap: Math.round(box.bottom - padding - bottom),
          };
        }),
      );
      for (const { heading, gap } of gaps) {
        expect(gap, heading).toBeLessThanOrEqual(MAX_TRAILING_GAP);
      }
    });
  }
});
