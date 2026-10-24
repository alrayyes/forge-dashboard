/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { isPlainClick } from './plain-click';

// A pill that is a real link opens its dialog on a plain click only; any
// other click is left to the browser, so "open in a new tab" keeps working.

const click = (over: Partial<Parameters<typeof isPlainClick>[0]> = {}) => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe('isPlainClick', () => {
  test('is true for an unmodified primary click', () => {
    expect(isPlainClick(click())).toBe(true);
  });

  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
    test(`is false with ${key} held`, () => {
      expect(isPlainClick(click({ [key]: true }))).toBe(false);
    });
  }

  test('is false for a middle click', () => {
    expect(isPlainClick(click({ button: 1 }))).toBe(false);
  });

  test('is false once something else handled the click', () => {
    expect(isPlainClick(click({ defaultPrevented: true }))).toBe(false);
  });
});
