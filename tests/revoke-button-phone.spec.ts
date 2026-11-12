import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './server-fixture';
import { addVirtualAuthenticator } from './webauthn-helper';

// On a phone the long meta line squeezed the Revoke button down to the 44px
// tap floor, so its label touched the right edge. The button keeps its size
// and the text wraps instead.
// https://github.com/alrayyes/forge-dashboard/issues/3188

const LONG_LABEL = 'deploy pipeline token for the staging cluster eu-west-1 x';

async function addToken(page: Page, label: string) {
  await page.fill('#token-label', label);
  await page.click('#token-form button[type="submit"]');
  await expect(page.locator('#token-status')).toContainText('Generated');
}

// Space between the button's edge and its label, each side.
async function labelGaps(button: Locator) {
  return button.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      left: text.left - box.left,
      right: box.right - text.right,
    };
  });
}

// Re-measures until the button is laid out and `ok` holds, so a layout still
// settling on a loaded runner doesn't fail the test. A button with no box, or
// no text, never passes.
async function expectGaps(
  button: Locator,
  ok: (g: Awaited<ReturnType<typeof labelGaps>>) => boolean,
) {
  await expect
    .poll(async () => {
      const g = await labelGaps(button);
      return g.width > 0 && g.height > 0 && ok(g);
    })
    .toBe(true);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/settings.html#integrations');
  await addToken(page, 'ci script');
  await addToken(page, LONG_LABEL);
  await expect(page.locator('#api-token-list li')).toHaveCount(2);
}

test.describe('Revoke button layout (#3188)', () => {
  test.beforeEach(async ({ page }) => {
    await addVirtualAuthenticator(page);
  });

  test('at 390px every Revoke button is at least 63 x 44 with its label centred', async ({
    page,
  }) => {
    await open(page, 390);
    for (const button of await page
      .locator('#api-token-list .btn-remove')
      .all()) {
      await expectGaps(
        button,
        (g) =>
          g.height >= 44 && g.width >= 63 && Math.abs(g.left - g.right) <= 1,
      );
    }
  });

  for (const width of [820, 1280]) {
    test(`at ${width}px the button stays 63 x 25 with 11px each side`, async ({
      page,
    }) => {
      await open(page, width);
      for (const button of await page
        .locator('#api-token-list .btn-remove')
        .all()) {
        await expectGaps(
          button,
          (g) =>
            Math.abs(g.width - 63) < 0.5 &&
            Math.abs(g.height - 25) < 0.5 &&
            Math.abs(g.left - 11) <= 1 &&
            Math.abs(g.right - 11) <= 1,
        );
      }
    });
  }

  test('at 390px a passkey Remove button meets the same size and centring', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings.html#integrations');
    await page.fill('#passkey-label', LONG_LABEL);
    await page.click('#passkey-form button[type="submit"]');
    await expect(page.locator('#passkey-list li')).toHaveCount(2);
    for (const button of await page
      .locator('#passkey-list .btn-remove')
      .all()) {
      await expectGaps(
        button,
        (g) =>
          g.height >= 44 && g.width >= 63 && Math.abs(g.left - g.right) <= 1,
      );
    }
  });

  test('at 390px a very long label wraps and nothing scrolls sideways', async ({
    page,
  }) => {
    await open(page, 390);
    const item = page.locator('#api-token-list li').nth(1);
    const itemBox = await box(item);
    const metaBox = await box(item.locator('.api-token-meta'));
    const buttonBox = await box(item.locator('.btn-remove'));
    expect(metaBox.x + metaBox.width).toBeLessThanOrEqual(buttonBox.x + 1);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
      itemBox.x + itemBox.width + 1,
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
  });

  test('axe is clean on the tokens card at 390px, 820px and 1280px', async ({
    page,
  }) => {
    // The tokens are made once and the page resized, so each width sees the
    // same two.
    await open(page, 390);
    for (const width of [390, 820, 1280]) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: 844 });
        const results = await new AxeBuilder({ page })
          .include('#api-tokens')
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  });
});
