/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  adviseReadIntervalMs,
  MAX_READ_INTERVAL_SECONDS,
} from './read-interval';

describe('adviseReadIntervalMs', () => {
  test('follows a sane advice', () => {
    expect(adviseReadIntervalMs(2, 30_000)).toBe(2000);
    expect(adviseReadIntervalMs(30, 2000)).toBe(30_000);
  });

  test('keeps the current interval for a missing, zero or negative advice', () => {
    for (const v of [undefined, null, 0, -5, 0.5, Number.NaN]) {
      expect(adviseReadIntervalMs(v, 10_000)).toBe(10_000);
    }
  });

  test('caps a huge advice so the timer cannot overflow', () => {
    expect(adviseReadIntervalMs(1e9, 10_000)).toBe(
      MAX_READ_INTERVAL_SECONDS * 1000,
    );
    expect(adviseReadIntervalMs(Number.POSITIVE_INFINITY, 10_000)).toBe(
      MAX_READ_INTERVAL_SECONDS * 1000,
    );
  });
});
