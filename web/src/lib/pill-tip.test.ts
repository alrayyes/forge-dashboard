/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { hasPillTitle, pillHoverText } from './pill-tip';

// What a pill says on hover and under focus (#4326): the item's title, then
// what the pill does. `bun test` has no DOM; the pills' own tests cover the
// wiring and pill-titles.spec.ts the page.

describe('pillHoverText', () => {
  test('leads with the title and puts the line under it', () => {
    expect(
      pillHoverText('Show titles', 'Closes the issue when it merges'),
    ).toBe('Show titles\nCloses the issue when it merges');
  });

  test('is the line alone when the title is unknown, with no empty row', () => {
    for (const none of [undefined, '', '   ', '\n\t'])
      expect(pillHoverText(none, 'Closes the issue when it merges')).toBe(
        'Closes the issue when it merges',
      );
  });

  test('keeps a title on one row, so it cannot fake a second line', () => {
    expect(pillHoverText('One\n\nTwo   three', 'Line')).toBe(
      'One Two three\nLine',
    );
  });

  test('passes markup through as the text it is', () => {
    expect(pillHoverText('<img src=x onerror=alert(1)>', 'Line')).toBe(
      '<img src=x onerror=alert(1)>\nLine',
    );
  });
});

describe('hasPillTitle', () => {
  test('is false for a missing or blank title and true otherwise', () => {
    expect(hasPillTitle(undefined)).toBe(false);
    expect(hasPillTitle(' \n')).toBe(false);
    expect(hasPillTitle('Show titles')).toBe(true);
  });
});
