import { describe, expect, test } from 'bun:test';
import {
  type ItemReference,
  incomingRows,
  mergeRows,
  outgoingRows,
  rowsOf,
} from './issue-references.js';

const ref = (over: Partial<ItemReference>): ItemReference => ({
  forge: 'github',
  repo: 'alrayyes/a',
  number: 1,
  title: 'Item',
  url: 'https://example.com/1',
  pageUrl: '/pull-requests.html?pr=github/alrayyes/a/1',
  kind: 'pullRequest',
  state: 'merged',
  direction: 'incoming',
  relation: 'closes',
  ...over,
});

describe('incomingRows', () => {
  test('sorts incoming references into the rows by relation and keeps their state', () => {
    const rows = incomingRows([
      ref({ number: 1 }),
      ref({ number: 2, relation: 'refs', state: 'open' }),
      ref({ number: 3, relation: 'mentions', kind: 'issue', state: 'closed' }),
    ]);

    expect(rows.linkedPullRequests.map((p) => p.number)).toEqual([1]);
    expect(rows.referencedByPullRequests.map((p) => p.number)).toEqual([2]);
    expect(rows.mentionedByPullRequests[0]).toMatchObject({
      number: 3,
      kind: 'issue',
      state: 'closed',
      url: 'https://example.com/1',
    });
  });

  test('leaves out what the issue itself refers to', () => {
    const rows = incomingRows([ref({ direction: 'outgoing' })]);

    expect(rows.linkedPullRequests).toEqual([]);
  });
});

describe('mergeRows', () => {
  const drawn = (number: number, ci: 'passed' | 'none') => ({
    ...incomingRows([ref({ number })]).linkedPullRequests[0],
    ci,
  });

  test('keeps what the board drew when the details list nothing', () => {
    const board = {
      linkedPullRequests: [drawn(13, 'passed')],
      referencedByPullRequests: [],
      mentionedByPullRequests: [],
    };

    expect(mergeRows(board, incomingRows([])).linkedPullRequests).toEqual([
      drawn(13, 'passed'),
    ]);
  });

  test('keeps the board pill, with its checks, over the same item from the details', () => {
    const board = {
      linkedPullRequests: [drawn(13, 'passed')],
      referencedByPullRequests: [],
      mentionedByPullRequests: [],
    };
    const merged = mergeRows(board, incomingRows([ref({ number: 13 })]));

    expect(merged.linkedPullRequests).toEqual([drawn(13, 'passed')]);
  });

  test('adds an item only the details know, after the board pills', () => {
    const board = {
      linkedPullRequests: [drawn(13, 'passed')],
      referencedByPullRequests: [],
      mentionedByPullRequests: [],
    };
    const merged = mergeRows(
      board,
      incomingRows([ref({ number: 14 }), ref({ number: 13 })]),
    );

    expect(merged.linkedPullRequests.map((p) => p.number)).toEqual([13, 14]);
  });

  test('puts an item the details list under two relations only under the strongest', () => {
    const none = incomingRows([]);
    const merged = mergeRows(
      none,
      incomingRows([
        ref({ number: 5, relation: 'mentions' }),
        ref({ number: 5, relation: 'refs' }),
        ref({ number: 5, relation: 'refs' }),
        ref({ number: 6, relation: 'mentions' }),
        ref({ number: 6, relation: 'closes' }),
        ref({ number: 7, relation: 'mentions' }),
        ref({ number: 7, relation: 'refs' }),
        ref({ number: 7, relation: 'closes' }),
      ]),
    );

    expect(merged.linkedPullRequests.map((p) => p.number)).toEqual([6, 7]);
    expect(merged.referencedByPullRequests.map((p) => p.number)).toEqual([5]);
    expect(merged.mentionedByPullRequests).toEqual([]);
  });

  test('tells two items with one number apart by their forge and repo', () => {
    const merged = mergeRows(
      incomingRows([ref({ number: 5 })]),
      incomingRows([
        ref({ number: 5, forge: 'forgejo' }),
        ref({ number: 5, repo: 'alrayyes/b' }),
      ]),
    );

    expect(merged.linkedPullRequests).toHaveLength(3);
  });

  test('keeps an item the board drew in its row, whatever the details say', () => {
    const board = {
      linkedPullRequests: [],
      referencedByPullRequests: [],
      mentionedByPullRequests: [drawn(9, 'passed')],
    };
    const merged = mergeRows(board, incomingRows([ref({ number: 9 })]));

    expect(merged.linkedPullRequests).toEqual([]);
    expect(merged.mentionedByPullRequests).toEqual([drawn(9, 'passed')]);
  });
});

describe('rowsOf', () => {
  test('reads the three rows of an item, an absent one as empty', () => {
    const pill = incomingRows([ref({ number: 2 })]).linkedPullRequests;

    expect(rowsOf({ linkedPullRequests: pill })).toEqual({
      linkedPullRequests: pill,
      referencedByPullRequests: [],
      mentionedByPullRequests: [],
    });
    expect(
      rowsOf({ referencedByPullRequests: pill }).referencedByPullRequests,
    ).toEqual(pill);
    expect(
      rowsOf({ mentionedByPullRequests: pill }).mentionedByPullRequests,
    ).toEqual(pill);
  });
});

describe('outgoingRows', () => {
  test('sorts what the issue refers to into closes, refs and mentions, in the order given', () => {
    const rows = outgoingRows([
      ref({ number: 1, direction: 'outgoing', relation: 'refs' }),
      ref({ number: 2, direction: 'outgoing', relation: 'mentions' }),
      ref({ number: 3, direction: 'outgoing', relation: 'refs' }),
      ref({ number: 4, direction: 'outgoing', relation: 'closes' }),
    ]);

    expect(rows.closes.map((p) => p.number)).toEqual([4]);
    expect(rows.refs.map((p) => p.number)).toEqual([1, 3]);
    expect(rows.mentions.map((p) => p.number)).toEqual([2]);
  });

  test('keeps the kind, state and addresses the pill draws', () => {
    const [row] = outgoingRows([
      ref({
        direction: 'outgoing',
        relation: 'refs',
        kind: 'issue',
        state: 'closed',
      }),
    ]).refs;

    expect(row).toMatchObject({
      forge: 'github',
      repo: 'alrayyes/a',
      number: 1,
      kind: 'issue',
      state: 'closed',
      url: 'https://example.com/1',
      pageUrl: '/pull-requests.html?pr=github/alrayyes/a/1',
    });
  });

  test('leaves out what refers to the issue', () => {
    const rows = outgoingRows([ref({ direction: 'incoming' })]);

    expect(rows).toEqual({ closes: [], refs: [], mentions: [] });
  });
});
