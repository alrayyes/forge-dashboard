import { expect, type Locator } from '@playwright/test';
import { test } from './server-fixture';

// The edge of a text field or dropdown is the part of it that identifies it,
// so it needs 3:1 against the card behind it and against its own fill
// (WCAG 2.2 SC 1.4.11). The Settings fields and the Issues regex field were
// left on --border-strong (about 1.6:1) when #3193 moved the filter bar over.
// https://github.com/alrayyes/forge-dashboard/issues/3207

type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The control's border, its own fill and the first opaque background above it.
async function edge(
  control: Locator,
): Promise<{ border: Rgb; fill: Rgb; behind: Rgb }> {
  return control.evaluate((el) => {
    const parse = (value: string) => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) throw new Error(`not a colour: ${value}`);
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).map(Number);
      return { rgb: [r, g, b] as Rgb, alpha: a };
    };
    let node: Element | null = el.parentElement;
    let behind: Rgb = [255, 255, 255];
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg.alpha === 1) {
        behind = bg.rgb;
        break;
      }
      node = node.parentElement;
    }
    const style = getComputedStyle(el);
    return {
      border: parse(style.borderTopColor).rgb,
      fill: parse(style.backgroundColor).rgb,
      behind,
    };
  });
}

// One control per Settings group, plus the ones with their own rule. One
// test per page per theme; the Settings groups are anchors on one page.
const CONTROLS: Record<string, [string, string][]> = {
  '/settings.html': [
    ['#display', '#timezone-select'],
    ['#connections', '#github-token'],
    ['#behaviour', '#ignored-pattern'],
    ['#integrations', '#passkey-label'],
    ['#integrations', '#token-label'],
    ['#integrations', '#token-expiry-preset'],
  ],
  '/issues.html': [['', '#issue-hide-title-regex']],
};

for (const scheme of ['light', 'dark'] as const) {
  for (const [path, controls] of Object.entries(CONTROLS)) {
    test(`the controls on ${path} have a 3:1 border in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [hash, selector] of controls) {
        await page.goto(`${path}${hash}`);
        const control = page.locator(selector);
        await expect(control, selector).toBeVisible();
        const soft = expect.configure({ soft: true });
        await soft
          .poll(
            async () => {
              const { border, behind } = await edge(control);
              return contrast(border, behind);
            },
            { message: selector },
          )
          .toBeGreaterThanOrEqual(3);
        await soft
          .poll(
            async () => {
              const { border, fill } = await edge(control);
              return contrast(border, fill);
            },
            { message: selector },
          )
          .toBeGreaterThanOrEqual(3);
      }
    });
  }
}

test('a focused Settings field still shows the 2px accent outline', async ({
  page,
}) => {
  await page.goto('/settings.html#connections');
  const field = page.locator('#github-token');
  await field.focus();
  await expect(field).toBeFocused();
  await expect(field).toHaveCSS('outline-width', '2px');
  await expect(field).toHaveCSS('outline-style', 'solid');
});
