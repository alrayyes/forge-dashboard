/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';

// rate-limit.ts reaches the timezone store, which needs the Svelte compiler.
mock.module('./time.svelte', () => ({ formatTime: (t: string) => t }));
const { isRateLimited, isRunningLow, rateLimitSeverity } = await import(
  './rate-limit'
);

const now = Date.parse('2030-01-01T12:00:00Z');
const future = '2030-01-01T12:10:00Z';
const past = '2030-01-01T11:50:00Z';

const grade = (limit: number, remaining: number, resetsAt: string) =>
  rateLimitSeverity({ limit, remaining, resetsAt }, now);

describe('rateLimitSeverity', () => {
  test('plenty left is ok', () => {
    expect(grade(5000, 4000, future)).toBe('ok');
  });

  test('exactly 20% left is still ok', () => {
    expect(grade(5000, 1000, future)).toBe('ok');
  });

  test('just under 20% is a warning', () => {
    expect(grade(5000, 999, future)).toBe('warning');
  });

  test('exactly 5% left is a warning, not low yet', () => {
    expect(grade(5000, 250, future)).toBe('warning');
  });

  test('just under 5% is low', () => {
    expect(grade(5000, 249, future)).toBe('low');
  });

  test('one request left is low', () => {
    expect(grade(5000, 1, future)).toBe('low');
  });

  test('spent with the reset ahead is exceeded', () => {
    expect(grade(5000, 0, future)).toBe('exceeded');
  });

  test('spent but already reset is low, not exceeded', () => {
    expect(grade(5000, 0, past)).toBe('low');
  });

  test('spent with no usable reset time is exceeded', () => {
    expect(grade(5000, 0, '')).toBe('exceeded');
    expect(grade(5000, 0, 'not a date')).toBe('exceeded');
  });

  test('the clock decides, so the same reading flips at the reset', () => {
    const rl = { limit: 5000, remaining: 0, resetsAt: future };
    expect(rateLimitSeverity(rl, Date.parse(future) - 1)).toBe('exceeded');
    expect(rateLimitSeverity(rl, Date.parse(future))).toBe('low');
  });

  test('a zero limit with requests left is ok, not a division by zero', () => {
    expect(grade(0, 3, future)).toBe('ok');
  });
});

describe('isRateLimited', () => {
  test('is true only for a spent budget ahead of its reset', () => {
    const spent = { limit: 5000, remaining: 0, resetsAt: future };
    expect(isRateLimited(spent, now)).toBe(true);
    expect(isRateLimited({ ...spent, remaining: 10 }, now)).toBe(false);
    expect(isRateLimited(spent, Date.parse(future) + 1)).toBe(false);
    expect(isRateLimited(undefined, now)).toBe(false);
  });
});

describe('isRunningLow', () => {
  test('is true for a low budget with something left', () => {
    expect(
      isRunningLow({ limit: 5000, remaining: 100, resetsAt: future }, now),
    ).toBe(true);
  });

  test('is false for a spent budget, even one past its reset', () => {
    expect(
      isRunningLow({ limit: 5000, remaining: 0, resetsAt: past }, now),
    ).toBe(false);
    expect(
      isRunningLow({ limit: 5000, remaining: 0, resetsAt: future }, now),
    ).toBe(false);
  });

  test('is false for a warning', () => {
    expect(
      isRunningLow({ limit: 5000, remaining: 500, resetsAt: future }, now),
    ).toBe(false);
  });
});
