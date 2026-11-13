/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { offerFilterBar } from './filters';

// The filter bar and the sort controls inside it show only when the page has
// more than one row to search or sort (#3670). The count is the list before
// filters, so a filter that narrows a longer list keeps the bar.
// https://github.com/alrayyes/forge-dashboard/issues/3670

const bar = () => ({ hidden: false }) as unknown as HTMLElement;

describe('offerFilterBar', () => {
  test('hides the bar for an empty list', () => {
    const b = bar();
    offerFilterBar(b, 0, true);
    expect(b.hidden).toBe(true);
  });

  test('hides the bar for a single row', () => {
    const b = bar();
    offerFilterBar(b, 1, true);
    expect(b.hidden).toBe(true);
  });

  test('shows the bar for two or more rows', () => {
    const b = bar();
    offerFilterBar(b, 2, true);
    expect(b.hidden).toBe(false);
  });

  test('counts the list before filters, so a long list keeps the bar', () => {
    const b = bar();
    offerFilterBar(b, 5, false);
    expect(b.hidden).toBe(false);
  });

  test('keeps the bar on a single row while a filter is active, so it can be cleared', () => {
    const b = bar();
    offerFilterBar(b, 1, false);
    expect(b.hidden).toBe(false);
  });

  test('hides the bar for an empty list even with a saved filter', () => {
    const b = bar();
    offerFilterBar(b, 0, false);
    expect(b.hidden).toBe(true);
  });

  test('brings the bar back when a second row arrives', () => {
    const b = bar();
    offerFilterBar(b, 1, true);
    offerFilterBar(b, 2, true);
    expect(b.hidden).toBe(false);
  });

  test('ignores a missing bar', () => {
    expect(() => offerFilterBar(null, 1, true)).not.toThrow();
  });
});
