/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  contrastRatio,
  labelChipColors,
  labelTextColor,
  relativeLuminance,
} from './label-color';

describe('relativeLuminance', () => {
  test('black is 0 and white is 1', () => {
    expect(relativeLuminance('000000')).toBe(0);
    expect(relativeLuminance('ffffff')).toBeCloseTo(1, 10);
  });

  test('green weighs most and blue least', () => {
    expect(relativeLuminance('00ff00')).toBeGreaterThan(
      relativeLuminance('ff0000'),
    );
    expect(relativeLuminance('ff0000')).toBeGreaterThan(
      relativeLuminance('0000ff'),
    );
  });

  test('reads upper and lower case alike', () => {
    expect(relativeLuminance('D73A4A')).toBe(relativeLuminance('d73a4a'));
  });
});

describe('contrastRatio', () => {
  test('black on white is 21:1, whichever way round', () => {
    expect(contrastRatio(0, 1)).toBeCloseTo(21, 10);
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 10);
  });

  test('a colour against itself is 1:1', () => {
    expect(contrastRatio(0.3, 0.3)).toBe(1);
  });
});

describe('labelTextColor', () => {
  test('light backgrounds get black and dark ones white', () => {
    expect(labelTextColor('ffffff')).toBe('#000000');
    expect(labelTextColor('ededed')).toBe('#000000');
    expect(labelTextColor('000000')).toBe('#ffffff');
    expect(labelTextColor('0b0f14')).toBe('#ffffff');
  });

  test("GitHub's default bug red takes black, which clears 4.5:1", () => {
    expect(labelTextColor('d73a4a')).toBe('#000000');
    expect(
      contrastRatio(relativeLuminance('d73a4a'), 0),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('always picks the higher-contrast ink', () => {
    for (const hex of ['0075ca', 'a2eeef', '7057ff', 'fbca04', 'e4e669']) {
      const bg = relativeLuminance(hex);
      const picked = labelTextColor(hex) === '#000000' ? 0 : 1;
      const other = picked === 0 ? 1 : 0;
      expect(contrastRatio(bg, picked)).toBeGreaterThanOrEqual(
        contrastRatio(bg, other),
      );
    }
  });
});

// The Label filter's pick is stored by name, so a chip in it has to look its
// colour up. A name can carry different colours in different repos. The rule:
// one colour when every item in scope that carries the name agrees on it, and
// none (a neutral chip) when they differ, so the filter never claims a colour
// that is only some repos' label.
describe('labelChipColors', () => {
  const item = (...labels: { name: string; color?: string }[]) => ({ labels });

  test('a name every item colours the same gets that colour', () => {
    const colors = labelChipColors([
      item({ name: 'bug', color: 'd73a4a' }),
      item({ name: 'bug', color: 'd73a4a' }, { name: 'docs', color: '0075ca' }),
    ]);
    expect(colors.get('bug')).toBe('d73a4a');
    expect(colors.get('docs')).toBe('0075ca');
  });

  test('a name with different colours in different repos gets none', () => {
    const colors = labelChipColors([
      item({ name: 'bug', color: 'd73a4a' }),
      item({ name: 'bug', color: '0075ca' }),
    ]);
    expect(colors.has('bug')).toBe(false);
  });

  test('names meet without regard to case, and so do the colours', () => {
    const colors = labelChipColors([
      item({ name: 'Bug', color: 'D73A4A' }),
      item({ name: 'bug', color: 'd73a4a' }),
    ]);
    expect(colors.get('bug')).toBe('d73a4a');
  });

  test('a copy with no colour does not count as a different one', () => {
    const colors = labelChipColors([
      item({ name: 'bug' }),
      item({ name: 'bug', color: 'd73a4a' }),
    ]);
    expect(colors.get('bug')).toBe('d73a4a');
  });

  test('a colour that is not six hex digits is ignored', () => {
    const colors = labelChipColors([
      item({ name: 'bug', color: 'red' }, { name: 'x', color: '#d73a4a' }),
    ]);
    expect(colors.has('bug')).toBe(false);
    expect(colors.has('x')).toBe(false);
  });

  test('items with no labels are fine', () => {
    expect(labelChipColors([{}, item()]).size).toBe(0);
  });
});
