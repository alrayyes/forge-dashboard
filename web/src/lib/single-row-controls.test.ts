/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { groupOffered, sortOffered } from './filters';
import { pickFilterVisible } from './shared-picks';

// A list the filters have left at one row, or none, has nothing to sort or
// group, and a label filter whose only choices belong to that one row can only
// empty it (#3886).
// https://github.com/alrayyes/forge-dashboard/issues/3886

describe('sortOffered', () => {
  test('is off for one row and for none', () => {
    expect(sortOffered(1)).toBe(false);
    expect(sortOffered(0)).toBe(false);
  });

  test('is on for two or more rows', () => {
    expect(sortOffered(2)).toBe(true);
    expect(sortOffered(38)).toBe(true);
  });
});

describe('groupOffered', () => {
  test('is off for one row or none while no grouping is chosen', () => {
    expect(groupOffered(1, '')).toBe(false);
    expect(groupOffered(0, '')).toBe(false);
  });

  test('stays on while a grouping is chosen, so it can be undone', () => {
    expect(groupOffered(1, 'repo')).toBe(true);
  });

  test('is on for two or more rows', () => {
    expect(groupOffered(2, '')).toBe(true);
  });
});

describe('pickFilterVisible over the rows it chooses from', () => {
  test('hides over one row when nothing is picked, even with two choices', () => {
    expect(pickFilterVisible(2, 0, 1)).toBe(false);
  });

  test('stays over one row while a pick is held', () => {
    expect(pickFilterVisible(2, 1, 1)).toBe(true);
  });

  test('shows for two rows with choices to narrow by', () => {
    expect(pickFilterVisible(2, 0, 2)).toBe(true);
  });

  test('keeps the old rule when the row count is not given', () => {
    expect(pickFilterVisible(2, 0)).toBe(true);
    expect(pickFilterVisible(1, 0)).toBe(false);
  });
});
