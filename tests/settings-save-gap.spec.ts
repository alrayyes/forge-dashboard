import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './server-fixture';

// https://github.com/alrayyes/forge-dashboard/issues/4851
//
// On Settings the Save button sat directly on the card below it. Save's row
// must leave the same gap under it as two cards leave between them, and no
// more than that when nothing follows it.

const WIDTHS = [320, 390, 768, 1280];
const TEXT_SIZES = [100, 175];
const SCHEMES = ['light', 'dark'] as const;

async function open(
  page: Page,
  group: string,
  width: number,
  pct: number,
  scheme: 'light' | 'dark',
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/settings.html#${group}`);
  await expect(page.locator(`#${group}`)).toBeVisible();
  if (pct !== 100) {
    await page.addStyleTag({
      content: `html { font-size: ${pct}% !important; }`,
    });
  }
  await page.evaluate(() => document.fonts.ready);
}

// The gap between two stacked cards, and the room under the visible Save row:
// to the next visible card, or to the bottom of the panels when none follows.
const measure = (page: Page, group: string) =>
  page.evaluate((id) => {
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;
    const cards = [...document.querySelectorAll(`#${id} .card`)].filter(
      visible,
    );
    const cardGap = Number.parseFloat(getComputedStyle(cards[0]).marginBottom);
    const row = [...document.querySelectorAll(`#${id} .actions`)]
      .filter(visible)
      .at(-1) as HTMLElement;
    const rowBox = row.getBoundingClientRect();
    const after = [...document.querySelectorAll('.settings-panels .card')]
      .filter(visible)
      .find(
        (c) =>
          (row.compareDocumentPosition(c) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
      );
    const panels = document.querySelector('.settings-panels') as HTMLElement;
    const below = after
      ? after.getBoundingClientRect().top - rowBox.bottom
      : panels.getBoundingClientRect().bottom - rowBox.bottom;
    return { cardGap, below, followed: Boolean(after) };
  }, group);

for (const scheme of SCHEMES) {
  for (const pct of TEXT_SIZES) {
    for (const width of WIDTHS) {
      test(`Save leaves the card gap under it at ${width}px, ${pct}%, ${scheme}`, async ({
        page,
      }) => {
        await open(page, 'behaviour', width, pct, scheme);
        await expect
          .poll(async () => {
            const m = await measure(page, 'behaviour');
            return m.followed && m.below >= m.cardGap - 0.5;
          })
          .toBe(true);
        const results = await new AxeBuilder({ page })
          .include('#behaviour')
          .analyze();
        expect(results.violations).toEqual([]);
      });

      test(`Save adds no extra space when it is last at ${width}px, ${pct}%, ${scheme}`, async ({
        page,
      }) => {
        await open(page, 'connections', width, pct, scheme);
        await expect
          .poll(async () => {
            const m = await measure(page, 'connections');
            return !m.followed && Math.abs(m.below - m.cardGap) <= 0.5;
          })
          .toBe(true);
        const results = await new AxeBuilder({ page })
          .include('#connections')
          .analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
}

test('Save and the cards share one gap: changing it moves both', async ({
  page,
}) => {
  await open(page, 'connections', 1280, 100, 'light');
  await page.addStyleTag({
    content: '.settings-panels { --card-gap: 40px !important; }',
  });
  await expect
    .poll(async () => {
      const m = await measure(page, 'connections');
      return m.cardGap === 40 && Math.abs(m.below - 40) <= 0.5;
    })
    .toBe(true);
});

test('a status message in the Save row keeps the card gap below it', async ({
  page,
}) => {
  await open(page, 'connections', 390, 100, 'light');
  await page.evaluate(() => {
    const status = document.querySelector(
      '#connections .actions .status',
    ) as HTMLElement;
    status.textContent =
      'Could not save settings. Check the highlighted fields and try again.';
  });
  await expect
    .poll(async () => {
      const m = await measure(page, 'connections');
      return !m.followed && Math.abs(m.below - m.cardGap) <= 0.5;
    })
    .toBe(true);
});
