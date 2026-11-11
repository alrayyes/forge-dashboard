/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { titleSegments } from './title-code';

// https://github.com/alrayyes/forge-dashboard/issues/3358

describe('titleSegments', () => {
  test('a title without backticks is one text segment', () => {
    expect(titleSegments('Add structured logging')).toEqual([
      { code: false, text: 'Add structured logging' },
    ]);
  });

  test('paired backticks become code segments with the ticks removed', () => {
    expect(titleSegments('bump golang from `d9b6a1b` to `dc0963f`')).toEqual([
      { code: false, text: 'bump golang from ' },
      { code: true, text: 'd9b6a1b' },
      { code: false, text: ' to ' },
      { code: true, text: 'dc0963f' },
    ]);
  });

  test('a span at the very start or end leaves no empty text segment', () => {
    expect(titleSegments('`a` b `c`')).toEqual([
      { code: true, text: 'a' },
      { code: false, text: ' b ' },
      { code: true, text: 'c' },
    ]);
  });

  test('an odd number of backticks shows as typed', () => {
    expect(titleSegments('bump `a` to `b')).toEqual([
      { code: false, text: 'bump `a` to `b' },
    ]);
    expect(titleSegments('`')).toEqual([{ code: false, text: '`' }]);
  });

  test('an empty pair shows as typed', () => {
    expect(titleSegments('a `` b')).toEqual([{ code: false, text: 'a `` b' }]);
  });

  test('HTML stays text, inside and outside a span', () => {
    expect(titleSegments('<img src=x onerror=1> `<b>x</b>`')).toEqual([
      { code: false, text: '<img src=x onerror=1> ' },
      { code: true, text: '<b>x</b>' },
    ]);
  });

  test('an empty title gives no segments', () => {
    expect(titleSegments('')).toEqual([]);
  });
});
