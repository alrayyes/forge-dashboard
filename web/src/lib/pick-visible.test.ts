/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { pickFilterVisible } from './shared-picks';

// #3496: a pick filter that offers one value and has nothing picked can't
// narrow anything, so it is hidden. A pick keeps it, so it can be cleared.
describe('pickFilterVisible', () => {
  test('hides with one choice and nothing picked', () => {
    expect(pickFilterVisible(1, 0)).toBe(false);
  });
  test('hides with no choice and nothing picked', () => {
    expect(pickFilterVisible(0, 0)).toBe(false);
  });
  test('shows with two or more choices', () => {
    expect(pickFilterVisible(2, 0)).toBe(true);
    expect(pickFilterVisible(5, 1)).toBe(true);
  });
  test('shows with one choice when it is picked', () => {
    expect(pickFilterVisible(1, 1)).toBe(true);
  });
});
