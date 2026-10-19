/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { headerLabel, pillParts, tabLabel } from './nav-labels';

// What assistive tech hears for a nav item with counts, with no browser. The
// layout feeds every nav item through these two functions, so the wording for
// each combination of counts is proved here rather than once per page.
// https://github.com/alrayyes/forge-dashboard/issues/1502

const MIXED = { total: 15, failed: 2, running: 3, passed: 10 };

describe('headerLabel', () => {
  test('leads with the numbers as drawn (WCAG 2.5.3), then the page, the total, then failing, passing, running', () => {
    expect(headerLabel('Pull requests', MIXED)).toBe(
      '15 2 10 3, Pull requests, 15 total, 2 failing, 10 passing, 3 running',
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
    ).toBe('8 8, Pull requests, 8 total, 8 passing');
    expect(
      headerLabel('Releases', { total: 6, failed: 0, running: 6, passed: 0 }),
    ).toBe('6 6, Releases, 6 total, 6 running');
    expect(
      headerLabel('Bots', { total: 4, failed: 1, running: 0, passed: 0 }),
    ).toBe('4 1, Bots, 4 total, 1 failing');
  });

  test('a count with only failed and total (Branches, Issues) omits the rest', () => {
    expect(headerLabel('Branches', { total: 12, failed: 3 })).toBe(
      '12 3, Branches, 12 total, 3 failing',
    );
    expect(headerLabel('Issues', { total: 9, failed: 0 })).toBe(
      '9, Issues, 9 total',
    );
  });

  test('names the branches without a pipeline last, and never as zero (#1531)', () => {
    expect(
      headerLabel('Branches', {
        total: 7,
        failed: 2,
        running: 1,
        passed: 3,
        none: 1,
      }),
    ).toBe(
      '7 2 3 1 1, Branches, 7 total, 2 failing, 3 passing, 1 running, 1 without a pipeline',
    );
    expect(
      headerLabel('Branches', {
        total: 3,
        failed: 0,
        running: 0,
        passed: 3,
        none: 0,
      }),
    ).toBe('3 3, Branches, 3 total, 3 passing');
  });

  test('large numbers are named whole', () => {
    expect(
      headerLabel('Pull requests', {
        total: 1204,
        failed: 18,
        running: 85,
        passed: 1100,
      }),
    ).toBe(
      '1204 18 1100 85, Pull requests, 1204 total, 18 failing, 1100 passing, 85 running',
    );
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
      '15 2 10 3 PRs, 2 failing, 10 passing, 3 running',
    );
    expect(
      tabLabel('Branches', { total: 7, failed: 2, running: 1, passed: 4 }),
    ).toBe('7 2 4 1 Branches, 2 failing, 4 passing, 1 running');
  });

  test('the tab says the branches without a pipeline in the same words (#1531)', () => {
    expect(
      tabLabel('Branches', {
        total: 7,
        failed: 2,
        running: 1,
        passed: 3,
        none: 1,
      }),
    ).toBe(
      '7 2 3 1 1 Branches, 2 failing, 3 passing, 1 running, 1 without a pipeline',
    );
  });

  test('never speaks a zero', () => {
    expect(tabLabel('Issues', { total: 9, failed: 0 })).toBe('9 Issues');
    expect(tabLabel('PRs', { total: 27, failed: 5 })).toBe(
      '27 5 PRs, 5 failing',
    );
  });

  test('is just the word with no count or an empty one', () => {
    expect(tabLabel('PRs', null)).toBe('PRs');
    expect(tabLabel('PRs', { total: 0, failed: 0 })).toBe('PRs');
  });
});

// The pill, the header name and the tab name all take their counts from
// pillParts, so the order and the zero rule cannot drift between them (#1944).
describe('pillParts', () => {
  test('lists the counts in the order the pill draws them, without the total', () => {
    expect(
      pillParts({ total: 20, failed: 2, passed: 10, running: 3, none: 5 }),
    ).toEqual([
      { kind: 'failed', n: 2, words: 'failing' },
      { kind: 'passed', n: 10, words: 'passing' },
      { kind: 'running', n: 3, words: 'running' },
      { kind: 'none', n: 5, words: 'without a pipeline' },
    ]);
  });

  test('leaves out a zero or a missing count', () => {
    expect(pillParts({ total: 4, failed: 0, running: 1 })).toEqual([
      { kind: 'running', n: 1, words: 'running' },
    ]);
    expect(pillParts({ total: 9, failed: 0 })).toEqual([]);
  });

  test('the names list the numbers in the same order, for every mix of counts', () => {
    for (let mask = 0; mask < 16; mask++) {
      const count = {
        total: 100,
        failed: mask & 1 ? 1 : 0,
        passed: mask & 2 ? 2 : 0,
        running: mask & 4 ? 3 : 0,
        none: mask & 8 ? 4 : 0,
      };
      const expected = ['100', ...pillParts(count).map((p) => String(p.n))];
      expect(headerLabel('X', count).split(',')[0]).toBe(expected.join(' '));
      expect(tabLabel('X', count).split(',')[0]).toBe(
        `${expected.join(' ')} X`,
      );
    }
  });
});
