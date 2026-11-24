/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { resultBarSentence, resultBarText } from './result-bar';

// The result bar's one line (#4288): the count, said the same way to the eye
// and to the polite live region.
describe('resultBarText (#4288)', () => {
  test('no filter reads the total alone', () => {
    expect(resultBarText(42, 42, 'pull requests', false)).toEqual({
      lead: '',
      number: '42',
      rest: ' pull requests',
    });
  });

  test('a filter reads "N of M" even when it leaves every row', () => {
    expect(resultBarText(12, 42, 'pull requests', true)).toEqual({
      lead: '',
      number: '12',
      rest: ' of 42 pull requests',
    });
    expect(resultBarText(42, 42, 'pull requests', true).rest).toBe(
      ' of 42 pull requests',
    );
  });

  test('one row uses the singular noun', () => {
    expect(resultBarText(1, 1, 'pull requests', false).rest).toBe(
      ' pull request',
    );
    expect(resultBarText(1, 1, 'issues', true).rest).toBe(' of 1 issue');
  });

  test('a zero total is "0 pull requests"', () => {
    expect(resultBarText(0, 0, 'pull requests', false).rest).toBe(
      ' pull requests',
    );
  });

  test('the parts join into the announcement', () => {
    expect(resultBarSentence(12, 42, 'pull requests', true)).toBe(
      '12 of 42 pull requests',
    );
    expect(resultBarSentence(42, 42, 'bot pull requests', false)).toBe(
      '42 bot pull requests',
    );
  });
});
