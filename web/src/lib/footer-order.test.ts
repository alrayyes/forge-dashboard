/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { ActionName } from './allowed-actions';
import { footerOrder } from './footer-order';

// The details dialog's footer lists the primary action first, the others in
// their own order, then the row's extras, and Close last (#943).

const named = (...names: ActionName[]): [ActionName, string | null][] =>
  names.map((n) => [n, n]);

describe('footerOrder', () => {
  test('the primary action comes first and Close last', () => {
    const { cells, primary } = footerOrder(
      named('merge', 'update_branch', 'auto_merge'),
      'auto_merge',
      [],
      'close',
    );
    expect(cells).toEqual(['auto_merge', 'merge', 'update_branch', 'close']);
    expect(primary).toEqual(['auto_merge']);
  });

  test('without a primary the others keep their order and Close stays last', () => {
    const { cells, primary } = footerOrder(
      named('merge', 'update_branch', 'auto_merge'),
      undefined,
      [],
      'close',
    );
    expect(cells).toEqual(['merge', 'update_branch', 'auto_merge', 'close']);
    expect(primary).toEqual([]);
  });

  test('an action that is not offered leaves no gap', () => {
    const { cells } = footerOrder(
      [
        ['merge', null],
        ['update_branch', 'update'],
        ['auto_merge', null],
      ],
      'merge',
      [],
      'close',
    );
    expect(cells).toEqual(['update', 'close']);
  });

  test('the extras sit after the named actions and before Close', () => {
    const { cells } = footerOrder(
      named('merge', 'auto_merge'),
      'merge',
      ['queue', 'hide'],
      'close',
    );
    expect(cells).toEqual(['merge', 'auto_merge', 'queue', 'hide', 'close']);
  });

  test('a primary Close is still last, and no named action is first', () => {
    const { cells, primary } = footerOrder(
      named('merge', 'auto_merge'),
      'close',
      [],
      'close',
    );
    expect(cells).toEqual(['merge', 'auto_merge', 'close']);
    expect(primary).toEqual([]);
  });

  test('no Close leaves the list without one', () => {
    const { cells } = footerOrder(named('merge'), 'merge', ['hide'], null);
    expect(cells).toEqual(['merge', 'hide']);
  });
});
