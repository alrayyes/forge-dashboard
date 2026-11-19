/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { SHOWN_PILLS as ISSUE_ROW_PILLS } from './closing-issues';
import { SHOWN_PILLS as PR_ROW_PILLS } from './linked-pull-requests';
import {
  DIALOG_SHOWN_PILLS,
  foldSplit,
  foldToggleName,
  foldToggleText,
  relatedBandData,
  relatedCount,
  relatedRows,
  relationLabel,
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
  });

  test('no row carries a hint, the pill says it does not close', () => {
    const lists = {
      closes: [ref('a/app', 1)],
      refs: [ref('a/app', 2)],
      mentions: [ref('a/app', 3)],
    };
    const node = {} as HTMLElement;
    const nodes = { closes: node, refs: node, mentions: node };
    for (const side of ['pull-request', 'issue', 'issue-outgoing'] as const) {
      for (const row of relatedRows(side, lists))
        expect(Object.keys(row)).not.toContain('hint');
      for (const row of relatedBandData(side, lists, nodes)?.rows ?? [])
        expect(Object.keys(row)).not.toContain('hintText');
    }
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

describe('what an issue refers to', () => {
  const node = () => ({}) as HTMLElement;
  const one = [ref('alrayyes/a', 1)];

  test('is labelled as the item does it, not as it is done to the issue', () => {
    expect(relationLabel('issue-outgoing', 'refs')).toBe('Refs');
    expect(relationLabel('issue-outgoing', 'mentions')).toBe('Mentions');
    expect(relationLabel('issue-outgoing', 'closes')).toBe('Closes');
  });

  test('follows the incoming rows, each under its own key', () => {
    const band = relatedBandData(
      'issue',
      { refs: one },
      { refs: node() },
      { lists: { refs: [ref('alrayyes/b', 2)] }, nodes: { refs: node() } },
    );

    expect(band?.rows.map((r) => [r.key, r.label])).toEqual([
      ['refs', 'Referenced by'],
      ['outgoing-refs', 'Refs'],
    ]);
  });

  test('keys the same item apart in each direction', () => {
    const band = relatedBandData(
      'issue',
      { refs: one },
      { refs: node() },
      { lists: { refs: one }, nodes: { refs: node() } },
    );

    expect(new Set(band?.rows.map((r) => r.key)).size).toBe(2);
  });

  test('makes a band of its own when nothing refers to the issue', () => {
    const band = relatedBandData(
      'issue',
      {},
      {},
      { lists: { mentions: one }, nodes: { mentions: node() } },
    );

    expect(band?.rows.map((r) => r.key)).toEqual(['outgoing-mentions']);
    expect(band?.count).toBe(1);
  });

  test('counts an item once across both directions', () => {
    const band = relatedBandData(
      'issue',
      { closes: one },
      { closes: node() },
      { lists: { refs: one }, nodes: { refs: node() } },
    );

    expect(band?.count).toBe(1);
  });

  test('draws no outgoing row without a node', () => {
    const band = relatedBandData(
      'issue',
      {},
      {},
      { lists: { refs: one }, nodes: {} },
    );

    expect(band).toBeUndefined();
  });
});
