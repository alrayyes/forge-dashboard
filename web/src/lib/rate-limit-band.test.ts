/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { RateLimit } from './rate-limit';
import { remainingBand } from './rate-limit-band';

const rl = (limit: number, remaining: number): RateLimit => ({
  limit,
  remaining,
  resetsAt: '2030-01-01T00:00:00Z',
  severity: 'low',
});

describe('remainingBand', () => {
  test('rounds the share left up to a coarse ceiling', () => {
    expect(remainingBand(rl(5000, 200))).toBe('under 5%');
    expect(remainingBand(rl(5000, 100))).toBe('under 5%');
    expect(remainingBand(rl(5000, 99))).toBe('under 2%');
    expect(remainingBand(rl(5000, 49))).toBe('under 1%');
    expect(remainingBand(rl(5000, 0))).toBe('under 1%');
  });

  test('stays the same while the count moves inside one band', () => {
    const bands = [249, 200, 150, 100].map((n) => remainingBand(rl(5000, n)));
    expect(new Set(bands).size).toBe(1);
  });

  test('says nothing it cannot back up', () => {
    expect(remainingBand(rl(0, 0))).toBeNull();
    expect(remainingBand(rl(5000, 6000))).toBeNull();
  });
});
