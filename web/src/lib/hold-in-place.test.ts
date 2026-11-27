/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { planHold } from './hold-in-place';

// How to put a control back where it was after the page above it changed height.
describe('holding a control in place', () => {
  // 1300px of content in an 800px window, so 500px of scroll.
  const page = {
    scrollY: 200,
    viewport: 800,
    height: 1300,
    above: 0,
    below: 0,
  };

  test('scrolls by as much as the control moved', () => {
    expect(planHold(40, page)).toEqual({ scrollTo: 240, above: 0, below: 0 });
    expect(planHold(-40, page)).toEqual({ scrollTo: 160, above: 0, below: 0 });
    expect(planHold(0, page)).toEqual({ scrollTo: 200, above: 0, below: 0 });
  });

  test('makes room below when the page cannot scroll that far down', () => {
    expect(planHold(40, { ...page, scrollY: 490 })).toEqual({
      scrollTo: 530,
      above: 0,
      below: 30,
    });
  });

  test('covers the unused height of a page shorter than the window', () => {
    expect(planHold(40, { ...page, scrollY: 0, height: 600 })).toEqual({
      scrollTo: 40,
      above: 0,
      below: 240,
    });
  });

  test('drops the room below once the page no longer needs it', () => {
    const short = { ...page, scrollY: 40, height: 840, below: 240 };
    expect(planHold(-40, short)).toEqual({ scrollTo: 0, above: 0, below: 0 });
  });

  test('makes room above when the page cannot scroll that far up', () => {
    expect(planHold(-40, { ...page, scrollY: 10 })).toEqual({
      scrollTo: 0,
      above: 30,
      below: 0,
    });
  });

  test('gives back the room above before scrolling down', () => {
    expect(planHold(40, { ...page, above: 30 })).toEqual({
      scrollTo: 210,
      above: 0,
      below: 0,
    });
  });

  test('keeps no room thinner than a pixel', () => {
    expect(planHold(0, { ...page, scrollY: 10, height: 809.6 })).toEqual({
      scrollTo: 10,
      above: 0,
      below: 0,
    });
    expect(planHold(29.6, { ...page, above: 30 }).above).toBe(0);
  });

  test('counts the room given back above when sizing the room below', () => {
    // Without the 30px above there are 770px of content, and 800px of window.
    const short = { ...page, scrollY: 0, height: 800, above: 30 };
    expect(planHold(40, short)).toEqual({ scrollTo: 10, above: 0, below: 40 });
  });
});
