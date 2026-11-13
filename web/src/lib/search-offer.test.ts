/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { searchOffered } from './filters';

// The title search hides when the other filters leave one row, since it has
// nothing to narrow, but never while it holds text (#3823).
// https://github.com/alrayyes/forge-dashboard/issues/3823

describe('searchOffered', () => {
  test('hides for exactly one row and an empty search', () => {
    expect(searchOffered(1, '')).toBe(false);
  });

  test('shows for two or more rows', () => {
    expect(searchOffered(2, '')).toBe(true);
    expect(searchOffered(40, '')).toBe(true);
  });

  test('stays while it holds text, even over one row', () => {
    expect(searchOffered(1, 'fix')).toBe(true);
  });

  test('shows for an empty list, which the bar already covers', () => {
    expect(searchOffered(0, '')).toBe(true);
  });
});
