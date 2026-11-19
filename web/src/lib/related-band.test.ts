/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { SHOWN_PILLS as ISSUE_ROW_PILLS } from './closing-issues';
import { SHOWN_PILLS as PR_ROW_PILLS } from './linked-pull-requests';
import {
  DIALOG_SHOWN_PILLS,
  foldSplit,
  foldToggleName,
  foldToggleText,
  relatedCount,
  relatedRows,
} from './related-band';

// The Related band at the top of the pull request and issue dialogs (#4220):
// which rows it has, its count and the fold. The pills' markup is the row
// builders'; the page wiring is related-band.spec.ts.

const ref = (repo: string, number: number) => ({ repo, number });

describe('the fold', () => {
  test('is 6 in a dialog while list rows keep their 2', () => {
    expect(DIALOG_SHOWN_PILLS).toBe(6);
    expect(ISSUE_ROW_PILLS).toBe(2);
    expect(PR_ROW_PILLS).toBe(2);
  });

  test('shows the first 6 and keeps the rest behind the toggle', () => {
    const list = Array.from({ length: 8 }, (_, i) => i);
    expect(foldSplit(list, DIALOG_SHOWN_PILLS)).toEqual({
      shown: [0, 1, 2, 3, 4, 5],
      rest: [6, 7],
    });
  });

  test('keeps nothing back for exactly 6', () => {
    const list = [1, 2, 3, 4, 5, 6];
    expect(foldSplit(list, DIALOG_SHOWN_PILLS).rest).toEqual([]);
  });
});

describe('the one persistent toggle', () => {
  test('reads +N more, then Show fewer', () => {
    expect(foldToggleText(2, false)).toBe('+2 more');
    expect(foldToggleText(2, true)).toBe('Show fewer');
  });

  test('has an accessible name that starts with its visible text (2.5.3)', () => {
    for (const expanded of [false, true]) {
      const text = foldToggleText(3, expanded);
      expect(
        foldToggleName(3, expanded, 'issues that this pull request closes'),
      ).toStartWith(text);
    }
    expect(
      foldToggleName(3, false, 'issues that this pull request closes'),
    ).toBe('+3 more, 3 more issues that this pull request closes');
    expect(
      foldToggleName(3, true, 'issues that this pull request closes'),
    ).toBe('Show fewer, hides 3 issues that this pull request closes');
  });
});

describe('the count', () => {
  test('is the distinct items across rows, not the rows', () => {
    expect(
      relatedCount([
        [ref('a/app', 1), ref('a/app', 2)],
        [ref('A/App', 2), ref('a/lib', 2)],
        undefined,
      ]),
    ).toBe(3);
  });

  test('is 0 with nothing related', () => {
    expect(relatedCount([undefined, []])).toBe(0);
  });
});

describe('the rows', () => {
  test('a pull request has Closes, Refs, Mentions in that order', () => {
    const rows = relatedRows('pull-request', {
      closes: [ref('a/app', 1)],
      refs: [ref('a/app', 2)],
      mentions: [ref('a/app', 3)],
    });
    expect(rows.map((r) => r.label)).toEqual(['Closes', 'Refs', 'Mentions']);
    expect(rows.map((r) => r.hint)).toEqual([false, true, true]);
  });

  test('an issue has Closed by, Referenced by, Mentioned by', () => {
    const rows = relatedRows('issue', {
      closes: [ref('a/app', 1)],
      refs: [ref('a/app', 2)],
      mentions: [ref('a/app', 3)],
    });
    expect(rows.map((r) => r.label)).toEqual([
      'Closed by',
      'Referenced by',
      'Mentioned by',
    ]);
  });

  test('leaves out a row with no items, and all rows when none has', () => {
    expect(
      relatedRows('issue', {
        closes: [],
        refs: undefined,
        mentions: [ref('a/b', 1)],
      }).map((r) => r.relation),
    ).toEqual(['mentions']);
    expect(relatedRows('pull-request', {})).toEqual([]);
  });
});
