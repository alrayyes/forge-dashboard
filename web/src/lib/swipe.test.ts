/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { swipeDismisses } from './swipe';

describe('swipeDismisses', () => {
  test('a drag past a third of the width, either way, dismisses', () => {
    expect(swipeDismisses(121, 360)).toBe(true);
    expect(swipeDismisses(-121, 360)).toBe(true);
  });

  test('a shorter drag, or none, springs back', () => {
    expect(swipeDismisses(119, 360)).toBe(false);
    expect(swipeDismisses(-119, 360)).toBe(false);
    expect(swipeDismisses(0, 360)).toBe(false);
  });

  test('a zero-width box never dismisses', () => {
    expect(swipeDismisses(50, 0)).toBe(false);
  });
});
