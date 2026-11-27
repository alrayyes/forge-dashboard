/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { lineCommentsNote } from './line-comments-note';

// What the dialog says about review comments on lines of code, which it counts
// and doesn't list (#5011).

describe('lineCommentsNote', () => {
  test('says nothing when there are none', () => {
    expect(lineCommentsNote(0, false)).toBeNull();
    expect(lineCommentsNote(undefined, undefined)).toBeNull();
  });

  test('words one comment in the singular', () => {
    expect(lineCommentsNote(1, false)).toEqual({
      text: "1 review comment on a line of code isn't shown here.",
      link: 'Read it',
    });
  });

  test('words several in the plural', () => {
    expect(lineCommentsNote(3, false)).toEqual({
      text: "3 review comments on lines of code aren't shown here.",
      link: 'Read them',
    });
  });

  test('says "at least" when the forge counted only some', () => {
    expect(lineCommentsNote(1, true)).toEqual({
      text: "At least 1 review comment on lines of code isn't shown here.",
      link: 'Read them',
    });
    expect(lineCommentsNote(120, true)?.text).toBe(
      "At least 120 review comments on lines of code aren't shown here.",
    );
  });
});
