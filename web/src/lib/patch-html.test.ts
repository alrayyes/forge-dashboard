import { describe, expect, test } from 'bun:test';
import { commonEnds } from './patch-html';

describe('commonEnds', () => {
  test('equal lists share everything', () => {
    expect(commonEnds(['a', 'b'], ['a', 'b'])).toEqual({ head: 2, tail: 0 });
  });
  test('a block added at the front keeps the rest as the tail', () => {
    expect(commonEnds(['b', 'c'], ['a', 'b', 'c'])).toEqual({
      head: 0,
      tail: 2,
    });
  });
  test('a block added at the end keeps the rest as the head', () => {
    expect(commonEnds(['a'], ['a', 'b'])).toEqual({ head: 1, tail: 0 });
  });
  test('a changed block in the middle keeps both sides', () => {
    expect(commonEnds(['a', 'x', 'c'], ['a', 'y', 'c'])).toEqual({
      head: 1,
      tail: 1,
    });
  });
  test('head and tail never overlap', () => {
    expect(commonEnds(['a', 'a'], ['a', 'a', 'a'])).toEqual({
      head: 2,
      tail: 0,
    });
  });
});
