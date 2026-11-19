/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  contrastRatio,
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
