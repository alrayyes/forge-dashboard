/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { fastest, growth } from './cpu-time';

// https://github.com/alrayyes/forge-dashboard/issues/4812
// A timing check must not fail because the machine was busy while it ran,
// and must still fail for a render that goes quadratic.

const burn = (iterations: number) => {
  let sink = 0;
  for (let i = 0; i < iterations; i++) sink += i & 1;
  return sink;
};

// 8x the input: linear work takes about 8x as long, quadratic about 64x.
const SMALL = 400;
const LARGE = 3200;
const LIMIT = 24;
const OPTIONS = { floorMs: 0.1 };

describe('growth', () => {
  test('stays under the limit for linear work', async () => {
    const linear = async (n: number) => {
      burn(n * 5000);
    };
    expect(await growth(linear, SMALL, LARGE, OPTIONS)).toBeLessThan(LIMIT);
  }, 30_000);

  test('goes past the limit for quadratic work', async () => {
    const quadratic = async (n: number) => {
      for (let i = 0; i < n; i++) burn(n * 8);
    };
    expect(await growth(quadratic, SMALL, LARGE, OPTIONS)).toBeGreaterThan(
      LIMIT,
    );
  }, 30_000);

  test('does not count time spent waiting for a core', async () => {
    const stalls = new Set([2, 4, 7, 9]);
    let calls = 0;
    const linear = async (n: number) => {
      burn(n * 5000);
      // A descheduled process burns no CPU but takes wall time.
      if (stalls.has(++calls)) await Bun.sleep(200);
    };
    expect(await growth(linear, SMALL, LARGE, OPTIONS)).toBeLessThan(LIMIT);
  }, 30_000);

  test('ignores one heavy sample at the large size', async () => {
    let large = 0;
    const linear = async (n: number) => {
      burn(n * 5000 * (n === LARGE && ++large === 2 ? 20 : 1));
    };
    expect(await growth(linear, SMALL, LARGE, OPTIONS)).toBeLessThan(LIMIT);
  }, 30_000);
});

describe('fastest', () => {
  test('is the quickest of the samples, not the first', async () => {
    let calls = 0;
    const took = await fastest(async () => {
      burn(++calls === 1 ? 50_000_000 : 1000);
    });
    expect(calls).toBeGreaterThan(1);
    expect(took).toBeLessThan(20);
  });
});
