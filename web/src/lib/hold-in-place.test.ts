/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { planHold } from './hold-in-place';

// How to put a control back where it was after the page above it changed height.
describe('holding a control in place', () => {
  const page = { scrollY: 200, maxScroll: 500, above: 0, below: 0 };

  test('scrolls by as much as the control moved', () => {
    expect(planHold(40, page)).toEqual({ scrollBy: 40, above: 0, below: 0 });
    expect(planHold(-40, page)).toEqual({ scrollBy: -40, above: 0, below: 0 });
    expect(planHold(0, page)).toEqual({ scrollBy: 0, above: 0, below: 0 });
  });

  test('makes room below when the page cannot scroll that far down', () => {
    expect(planHold(40, { ...page, scrollY: 490 })).toEqual({
      scrollBy: 40,
      above: 0,
      below: 30,
    });
  });

  test('makes room above when the page cannot scroll that far up', () => {
    expect(planHold(-40, { ...page, scrollY: 10 })).toEqual({
      scrollBy: -10,
      above: 30,
      below: 0,
    });
  });

  test('gives back the room above before scrolling down', () => {
    expect(planHold(40, { ...page, above: 30 })).toEqual({
      scrollBy: 10,
      above: 0,
      below: 0,
    });
  });
});
