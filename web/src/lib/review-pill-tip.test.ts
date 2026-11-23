/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { commentPillTip, whenWritten } from './review-pill-tip';

// What the comment pill's tip says (#4539): the count, then when the newest
// comment was written. `bun test` has no DOM; review-comments-pill.spec.ts
// covers the page.

const now = Date.parse('2026-11-23T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('whenWritten', () => {
  test('spells the age out in words, so a screen reader reads it right', () => {
    expect(whenWritten(ago(10_000), now)).toBe('just now');
    expect(whenWritten(ago(MIN), now)).toBe('1 minute ago');
    expect(whenWritten(ago(5 * MIN), now)).toBe('5 minutes ago');
    expect(whenWritten(ago(HOUR), now)).toBe('1 hour ago');
    expect(whenWritten(ago(2 * HOUR), now)).toBe('2 hours ago');
    expect(whenWritten(ago(3 * DAY), now)).toBe('3 days ago');
  });

  test('reads a time ahead of the clock as just now', () => {
    expect(whenWritten(ago(-5 * MIN), now)).toBe('just now');
  });

  test('is empty when there is no usable time', () => {
    for (const none of [undefined, null, '', 'yesterday-ish'])
      expect(whenWritten(none, now)).toBe('');
  });
});

describe('commentPillTip', () => {
  const base = { comments: 4, open: 1, word: 'comment' };

  test('says the count, the open threads and when the last comment was written', () => {
    expect(commentPillTip({ ...base, lastCommentAt: ago(2 * HOUR) }, now)).toBe(
      '4 comments, 1 open thread. Last comment 2 hours ago.',
    );
  });

  test('leaves the open threads out when none are open', () => {
    expect(
      commentPillTip({ ...base, open: 0, lastCommentAt: ago(5 * MIN) }, now),
    ).toBe('4 comments. Last comment 5 minutes ago.');
  });

  test('keeps the plain wording of the count, singular and plural', () => {
    expect(
      commentPillTip(
        { comments: 1, open: 2, word: 'review comment', lastCommentAt: null },
        now,
      ),
    ).toBe('1 review comment, 2 open threads.');
  });

  test('is today’s text with no empty or undefined part when the time is unknown', () => {
    for (const none of [undefined, null, '', 'not a date']) {
      const text = commentPillTip({ ...base, lastCommentAt: none }, now);
      expect(text).toBe('4 comments, 1 open thread.');
      expect(text).not.toMatch(/undefined|null|Last comment/);
    }
  });
});
