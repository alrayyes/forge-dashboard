import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator } from '@playwright/test';
import { test } from './server-fixture';

// The Show, Hide and Copy buttons inside a Settings field sit wholly inside the field's
// border, so the border reads as a closed outline all the way round. On a
// phone each button is a 44px target and the field was 44px tall, so a button
// covered the right-hand border.
// https://github.com/alrayyes/forge-dashboard/issues/4850

const WIDTHS = [320, 390, 768, 1280];
const TEXT = [100, 175];
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
        let pairs = 0;

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
              const i = await box(field);
              return {
                x: i.x + 1,
                y: i.y + 1,
                width: i.width - 2,
                height: i.height - 2,
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
            if (boxes.length === 2) {
              pairs++;
              expect(
                boxes[0].x + boxes[0].width <= boxes[1].x,
                `${url} field ${i} buttons overlap`,
              ).toBe(true);
            }
            await field.focus();
            const card = await box(
              field.locator('xpath=ancestor::*[contains(@class,"card")][1]'),
            );
            expect(
              inside(await box(field), card, RING),
              `${url} field ${i} ring`,
            ).toBe(true);
            checked++;
          }
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          expect(results.violations).toEqual([]);
        }
        // Show on GitHub and Forgejo, Copy on both webhook URLs, and the
        // Secret with its two buttons: the test must have seen them all.
        expect(checked).toBeGreaterThanOrEqual(6);
        expect(toggles).toBeGreaterThanOrEqual(3);
        expect(pairs).toBeGreaterThanOrEqual(1);
      });
    }
  }
}
