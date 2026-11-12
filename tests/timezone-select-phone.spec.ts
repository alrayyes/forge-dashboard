import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// On a phone the Time zone select sat beside its label and was cut to
// "Browser default (Europe/Amst". The label now sits above it and the select
// takes the card's width, so the whole selected zone reads.
// https://github.com/alrayyes/forge-dashboard/issues/3366

const select = (page: Page) => page.locator('#timezone-select');

function mockSavedZone(page: Page, timezone: string) {
  return page.route('**/api/v1/settings/timezone', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ timezone }),
        })
      : route.continue(),
  );
}

async function open(page: Page, width: number, saved: string) {
  await page.setViewportSize({ width, height: 800 });
  await mockSavedZone(page, saved);
  await page.goto('/settings.html#display');
  await expect(select(page)).toBeVisible();
}

// Whether the selected option's text is wider than the select's room for it.
function textOverflow(page: Page): Promise<number> {
  return select(page).evaluate((el) => {
    const s = el as HTMLSelectElement;
    const style = getComputedStyle(s);
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = s.selectedOptions[0].textContent ?? '';
    const room =
      s.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      24; // the dropdown arrow, with slack: Chromium reserves about 21px, other engines differ
    return ctx.measureText(text).width - room;
  });
}

for (const width of [320, 390]) {
  test.describe(`at ${width}px`, () => {
    test('the label sits above a full-width select', async ({ page }) => {
      await open(page, width, '');
      const label = await page
        .locator('label[for="timezone-select"]')
        .boundingBox();
      const field = await select(page).boundingBox();
      const card = await page
        .locator('.timezone-row')
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(label && field).toBeTruthy();
      expect(label!.y + label!.height).toBeLessThanOrEqual(field!.y);
      expect(field!.width).toBeGreaterThanOrEqual(card - 1);
    });

    test('the default zone shows whole', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await open(page, width, '');
      await expect.poll(() => textOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('a long zone shows whole below the select and does not overflow', async ({
      page,
    }) => {
      await open(page, width, 'America/Argentina/Buenos_Aires');
      await expect(page.locator('#timezone-preview')).toContainText(
        'America/Argentina/Buenos_Aires',
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test('the label stays bound to the select and axe is clean', async ({
  page,
}) => {
  await open(page, 320, '');
  await expect(page.getByLabel('Time zone')).toHaveId('timezone-select');
  const result = await new AxeBuilder({ page })
    .include('.timezone-row')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations).toEqual([]);
});

test('from 760px the label and select still share a row', async ({ page }) => {
  await open(page, 900, '');
  const label = await page
    .locator('label[for="timezone-select"]')
    .boundingBox();
  const field = await select(page).boundingBox();
  const row = await page
    .locator('.timezone-row')
    .evaluate((el) => el.getBoundingClientRect().width);
  // Same row, and the select keeps its own width rather than filling the card.
  expect(label && field).toBeTruthy();
  expect(label!.y + label!.height).toBeGreaterThan(field!.y);
  expect(field!.width).toBeLessThan(row - 1);
});
