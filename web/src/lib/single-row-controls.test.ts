/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  dateFilterOffered,
  groupChoices,
  groupOffered,
  sortChoices,
  sortOffered,
} from './filters';
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

describe('groupChoices', () => {
  const row = (forge: string, repo: string) => ({ forge, repo });

  test('offers nothing for one row, none, or one repo', () => {
    expect(groupChoices([])).toEqual({ repo: false, forge: false });
    expect(groupChoices([row('github', 'a/b')])).toEqual({
      repo: false,
      forge: false,
    });
    expect(groupChoices([row('github', 'a/b'), row('github', 'a/b')])).toEqual({
      repo: false,
      forge: false,
    });
  });

  test('offers repository for two repos on one forge', () => {
    expect(groupChoices([row('github', 'a/b'), row('github', 'a/c')])).toEqual({
      repo: true,
      forge: false,
    });
  });

  test('a repo name on two forges is two repos, and two forges', () => {
    expect(groupChoices([row('github', 'a/b'), row('forgejo', 'a/b')])).toEqual(
      {
        repo: true,
        forge: true,
      },
    );
  });
});

describe('groupOffered', () => {
  test('is on when either choice is', () => {
    expect(groupOffered({ repo: false, forge: false })).toBe(false);
    expect(groupOffered({ repo: true, forge: false })).toBe(true);
    expect(groupOffered({ repo: false, forge: true })).toBe(true);
  });
});

describe('sortChoices', () => {
  test('Repository needs two repos', () => {
    expect(sortChoices(1)).toEqual({ repo: false });
    expect(sortChoices(2)).toEqual({ repo: true });
  });
});

describe('dateFilterOffered', () => {
  test('hides over one row unless a value is set', () => {
    expect(dateFilterOffered(1, '')).toBe(false);
    expect(dateFilterOffered(0, '')).toBe(false);
    expect(dateFilterOffered(1, '1440')).toBe(true);
    expect(dateFilterOffered(2, '')).toBe(true);
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
