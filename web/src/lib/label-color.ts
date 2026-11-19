import { labelKey } from './label-name';

// The ink on a label's chip. A label's colour is arbitrary and forge-supplied,
// not one of this app's own pre-checked pairs, so the ink is whichever of true
// black or true white reads better against it. The rows and the Label filter
// share this, so one label looks the same in both.

// WCAG relative luminance of a colour given as six hex digits, no `#`.
// https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
export function relativeLuminance(hex: string): number {
  function channel(c: number): number {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }
  const r = channel(Number.parseInt(hex.slice(0, 2), 16));
  const g = channel(Number.parseInt(hex.slice(2, 4), 16));
  const b = channel(Number.parseInt(hex.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// True black or white, not this app's own --ink tokens: a themed near-black
// measurably under-performs pure black against an arbitrary background (GitHub's
// default "bug" red, #d73a4a, clears 4.5:1 against pure black at 4.59:1 but only
// 4.2:1 against #0b0f14). The decision and the applied colour have to name the
// same black, or a label can fail axe-core's contrast check despite this
// function "picking the higher-contrast option".
export function labelTextColor(bgHex: string): string {
  const bg = relativeLuminance(bgHex);
  const blackContrast = contrastRatio(bg, 0);
  const whiteContrast = contrastRatio(bg, 1);
  return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}

const HEX = /^[0-9a-f]{6}$/i;

// The colour a chip may wear, as lower-case hex without the `#`, or undefined
// for the neutral chip. The rows and the Label filter both ask this, so a
// malformed colour looks the same in both.
export function labelChipColor(color: string | undefined): string | undefined {
  return color && HEX.test(color) ? color.toLowerCase() : undefined;
}

// The colour each label name wears in the Label filter, by labelKey. A pick is
// stored by name, so a chip has to look its colour up, and one name can carry
// different colours in different repos. The rule is that a name gets a colour
// only when every item in scope that colours it agrees; where they differ it
// gets none and the chip stays neutral, rather than claim a colour that is only
// some repos' label. A copy with no usable colour takes no part in the vote.
export function labelChipColors(
  items: readonly { labels?: { name: string; color?: string }[] }[],
): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const item of items) {
    for (const { name, color } of item.labels ?? []) {
      const hex = labelChipColor(color);
      if (!hex) continue;
      const key = labelKey(name);
      const known = seen.get(key);
      if (known === undefined) seen.set(key, hex);
      else if (known !== hex) seen.set(key, null);
    }
  }
  const colors = new Map<string, string>();
  for (const [key, hex] of seen) if (hex) colors.set(key, hex);
  return colors;
}
