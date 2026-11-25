import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator } from '@playwright/test';
import { test } from './server-fixture';

// The Show, Hide and Copy buttons inside a Settings field sit wholly inside the field's
// border, so the border reads as a closed outline all the way round. On a
// phone each button is a 44px target and the field was 44px tall, so a button
// covered the right-hand border.
// https://github.com/alrayyes/forge-dashboard/issues/4850
// The field text also stops short of the first button at every text size, new-token field included.
// https://github.com/alrayyes/forge-dashboard/issues/4863

const WIDTHS = [320, 390, 768, 1280];
const TEXT = [100, 150, 175];
const RING = 3; // 2px outline plus 1px offset

type Box = { x: number; y: number; width: number; height: number };

function inside(inner: Box, outer: Box, pad = 0) {
  return (
    inner.x - pad >= outer.x &&
    inner.y - pad >= outer.y &&
    inner.x + inner.width + pad <= outer.x + outer.width &&
    inner.y + inner.height + pad <= outer.y + outer.height
  );
}

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return b;
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of WIDTHS) {
    for (const text of TEXT) {
      test(`the buttons in Settings fields sit inside them at ${width}px, ${text}% text, ${scheme}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
        let checked = 0;
        let toggles = 0;
        let revealed = false;
        let sawReveal = false;

        await page.goto('/settings.html');
        const groups = await page
          .locator('.group[id]')
          .evaluateAll((els) => els.map((el) => el.id));
        expect(groups.length).toBeGreaterThan(1);

        for (const group of groups) {
          const url = `/settings.html#${group}`;
          await page.goto(url);
          // Open every disclosure so a field inside one is measured too.
          await page.evaluate(() => {
            for (const d of document.querySelectorAll('details')) d.open = true;
          });
          await page.addStyleTag({ content: `html { font-size: ${text}%; }` });
          if (group === 'integrations') {
            // The new-token field only exists once a token is made.
            await page.fill('#token-label', 'ci script');
            await page.click('#token-form button[type="submit"]');
            await expect(page.locator('#token-reveal-field')).toBeVisible();
            revealed = true;
          }
          const fields = page.locator('.token-input:visible');
          const count = await fields.count();
          for (let i = 0; i < count; i++) {
            const wrap = fields.nth(i);
            const field = wrap.locator('input');
            const buttons = wrap.locator('button');
            const n = await buttons.count();
            if (n === 0) continue;
            // Re-measured each time: focusing scrolls the page.
            const paddingBox = async (): Promise<Box> => {
              const f = await box(field);
              return {
                x: f.x + 1,
                y: f.y + 1,
                width: f.width - 2,
                height: f.height - 2,
              };
            };
            const boxes: Box[] = [];
            for (let j = 0; j < n; j++) {
              const button = buttons.nth(j);
              const b = await box(button);
              boxes.push(b);
              expect(
                inside(b, await paddingBox()),
                `${url} field ${i} button ${j}`,
              ).toBe(true);
              await button.focus();
              expect(
                inside(await box(button), await paddingBox(), RING),
                `${url} field ${i} button ${j} focus ring`,
              ).toBe(true);
              if (
                await button.evaluate((el) =>
                  el.classList.contains('token-toggle'),
                )
              )
                toggles++;
            }
            // The room kept for the buttons: text in the field must end before
            // the first button starts (#4863). A long value can't be hidden
            // under a button.
            const room = await field.evaluate((el) =>
              parseFloat(getComputedStyle(el).paddingRight),
            );
            const fb = await box(field);
            expect(
              fb.x + fb.width - 1 - room,
              `${url} field ${i} text runs under a button`,
            ).toBeLessThanOrEqual(boxes[0].x);
            await field.focus();
            const card = await box(
              field.locator('xpath=ancestor::*[contains(@class,"card")][1]'),
            );
            expect(
              inside(await box(field), card, RING),
              `${url} field ${i} ring`,
            ).toBe(true);
            if ((await wrap.locator('#token-reveal-value').count()) > 0)
              sawReveal = true;
            checked++;
          }
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          expect(results.violations).toEqual([]);
        }
        // Show on the GitHub and Forgejo token fields, Copy on the MCP address
        // and on the new-token field: four fields, two of them toggles. Each
        // holds one button, so there is no pair to keep apart.
        expect(checked).toBeGreaterThanOrEqual(4);
        expect(toggles).toBeGreaterThanOrEqual(2);
        expect(revealed).toBe(true);
        expect(sawReveal).toBe(true);
      });
    }
  }
}
