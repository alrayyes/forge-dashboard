/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { headerLabel, tabLabel } from './nav-labels';

// What assistive tech hears for a nav item with counts, with no browser. The
// layout feeds every nav item through these two functions, so the wording for
// each combination of counts is proved here rather than once per page.
// https://github.com/alrayyes/forge-dashboard/issues/1502

const MIXED = { total: 15, failed: 2, running: 3, passed: 10 };

describe('headerLabel', () => {
  test('leads with the page, then the total, then failing, running, passing', () => {
    expect(headerLabel('Pull requests', MIXED)).toBe(
      'Pull requests, 15 total, 2 failing, 3 running, 10 passing',
    );
  });

  test('never speaks a zero', () => {
    expect(
      headerLabel('Pull requests', {
        total: 8,
        failed: 0,
        running: 0,
        passed: 8,
      }),
    ).toBe('Pull requests, 8 total, 8 passing');
    expect(
      headerLabel('Releases', { total: 6, failed: 0, running: 6, passed: 0 }),
    ).toBe('Releases, 6 total, 6 running');
    expect(
      headerLabel('Bots', { total: 4, failed: 1, running: 0, passed: 0 }),
    ).toBe('Bots, 4 total, 1 failing');
  });

  test('a count with only failed and total (Branches, Issues) omits the rest', () => {
    expect(headerLabel('Branches', { total: 12, failed: 3 })).toBe(
      'Branches, 12 total, 3 failing',
    );
    expect(headerLabel('Issues', { total: 9, failed: 0 })).toBe(
      'Issues, 9 total',
    );
  });

  test('large numbers are named whole', () => {
    expect(
      headerLabel('Pull requests', {
        total: 1204,
        failed: 18,
        running: 85,
        passed: 1100,
      }),
    ).toBe('Pull requests, 1204 total, 18 failing, 85 running, 1100 passing');
  });

  test('is just the page with no count or an empty one', () => {
    expect(headerLabel('Issues', null)).toBe('Issues');
    expect(
      headerLabel('Issues', { total: 0, failed: 0, running: 0, passed: 0 }),
    ).toBe('Issues');
  });
});

describe('tabLabel', () => {
  test('puts the total before the tab word, then the states in the same order', () => {
    expect(tabLabel('PRs', MIXED)).toBe(
      '15 PRs, 2 failing, 3 running, 10 passing',
    );
    expect(
      tabLabel('Branches', { total: 7, failed: 2, running: 1, passed: 4 }),
    ).toBe('7 Branches, 2 failing, 1 running, 4 passing');
  });

  test('never speaks a zero', () => {
    expect(tabLabel('Issues', { total: 9, failed: 0 })).toBe('9 Issues');
    expect(tabLabel('PRs', { total: 27, failed: 5 })).toBe('27 PRs, 5 failing');
  });

  test('is just the word with no count or an empty one', () => {
    expect(tabLabel('PRs', null)).toBe('PRs');
    expect(tabLabel('PRs', { total: 0, failed: 0 })).toBe('PRs');
  });
});
