/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { shownCountParts } from './shown-count';

// The count line's words are pinned by many specs, so the parts must join back
// to exactly today's text. Only the number is set apart, so CSS can weigh it.
describe('shownCountParts (#3867)', () => {
  test('an unfiltered list is "N open" with the total emphasised', () => {
    expect(shownCountParts(4, 4)).toEqual({
      before: '',
      number: '4',
      after: ' open',
    });
  });

  test('a filtered list is "Showing N of T" with the shown number emphasised', () => {
    expect(shownCountParts(2, 4)).toEqual({
      before: 'Showing ',
      number: '2',
      after: ' of 4',
    });
  });

  test('an empty filter result keeps its zero emphasised', () => {
    expect(shownCountParts(0, 4)).toEqual({
      before: 'Showing ',
      number: '0',
      after: ' of 4',
    });
  });

  test('an empty list is "0 open"', () => {
    expect(shownCountParts(0, 0)).toEqual({
      before: '',
      number: '0',
      after: ' open',
    });
  });
});
