/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { CHECK_STATE_LABELS, formatCheckDuration } from './pipeline-checks';

describe('formatCheckDuration', () => {
  test('seconds alone under a minute', () => {
    expect(formatCheckDuration(42)).toBe('42s');
  });

  test('minutes and seconds under an hour', () => {
    expect(formatCheckDuration(125)).toBe('2m 5s');
  });

  test('hours and minutes from an hour up', () => {
    expect(formatCheckDuration(3700)).toBe('1h 1m');
  });
});

describe('CHECK_STATE_LABELS', () => {
  test('names every state the checks endpoint can answer', () => {
    expect(Object.keys(CHECK_STATE_LABELS).sort()).toEqual([
      'awaiting_approval',
      'cancelled',
      'failure',
      'queued',
      'running',
      'skipped',
      'success',
      'timed_out',
    ]);
  });
});
