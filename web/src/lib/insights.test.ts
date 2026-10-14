/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { FilterableItem } from './filters';
import { AGE_BUCKETS, bucketAges, bucketForAge, rankByRepo } from './insights';

// The Insights page's aggregation rules, with no browser: which age bucket an
// item falls into, and how repos are ranked. The page only draws the answers.
// https://github.com/alrayyes/forge-dashboard/issues/1383

const NOW = Date.parse('2026-10-14T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function item(overrides: Partial<FilterableItem> = {}): FilterableItem {
  return {
    forge: 'github',
    repo: 'alrayyes/app',
    title: 'An item',
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

describe('bucketForAge', () => {
  test.each([
    [0, 'lt1'],
    [23.9, 'lt1'],
    [24, '1to3'],
    [71.9, '1to3'],
    [72, '3to7'],
    [167.9, '3to7'],
    [168, '7to30'],
    [719.9, '7to30'],
    [720, '30plus'],
  ])('%p hours old is in %p', (hours, key) => {
    expect(bucketForAge(hours)).toBe(key);
  });

  test('anything older than every named bucket lands in the last one, not nowhere', () => {
    expect(bucketForAge(24 * 400)).toBe('30plus');
    expect(bucketForAge(Number.MAX_SAFE_INTEGER)).toBe('30plus');
  });

  test('an item dated in the future (clock skew) counts as the newest bucket', () => {
    expect(bucketForAge(-5)).toBe('lt1');
  });
});

describe('bucketAges', () => {
  test('counts each item in its bucket, measured against the time it is given', () => {
    const { counts } = bucketAges(
      [
        item({ createdAt: hoursAgo(2) }),
        item({ createdAt: hoursAgo(48) }),
        item({ createdAt: hoursAgo(48) }),
        item({ createdAt: hoursAgo(24 * 5) }),
        item({ createdAt: hoursAgo(24 * 15) }),
      ],
      NOW,
    );

    expect(counts).toEqual({
      lt1: 1,
      '1to3': 2,
      '3to7': 1,
      '7to30': 1,
      '30plus': 0,
    });
  });

  test('every bucket is present at zero, so a chart never has a missing bar', () => {
    const { counts, maxCount } = bucketAges([], NOW);

    expect(Object.keys(counts)).toEqual(AGE_BUCKETS.map((b) => b.key));
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(maxCount).toBe(0);
  });

  test('maxCount is the tallest bucket, which scales the bars', () => {
    const { maxCount } = bucketAges(
      [
        item({ createdAt: hoursAgo(48) }),
        item({ createdAt: hoursAgo(49) }),
        item({ createdAt: hoursAgo(50) }),
        item({ createdAt: hoursAgo(1) }),
      ],
      NOW,
    );

    expect(maxCount).toBe(3);
  });

  test('a very old item is counted in 30+ days, never dropped', () => {
    const { counts } = bucketAges(
      [item({ createdAt: hoursAgo(24 * 400) })],
      NOW,
    );

    expect(counts['30plus']).toBe(1);
  });
});

describe('rankByRepo', () => {
  const repos = (spec: Record<string, number>) =>
    Object.entries(spec).flatMap(([repo, n]) =>
      Array.from({ length: n }, () => item({ repo })),
    );

  test('ranks repos by how many items they have, most first', () => {
    const { top, maxCount } = rankByRepo(
      repos({ 'alrayyes/one': 3, 'alrayyes/two': 1, 'alrayyes/three': 2 }),
    );

    expect(top).toEqual([
      { repo: 'alrayyes/one', count: 3 },
      { repo: 'alrayyes/three', count: 2 },
      { repo: 'alrayyes/two', count: 1 },
    ]);
    expect(maxCount).toBe(3);
  });

  test('repos with the same count keep the order they were first seen in', () => {
    const { top } = rankByRepo(
      repos({ 'a/first': 2, 'a/second': 2, 'a/third': 2 }),
    );

    expect(top.map((r) => r.repo)).toEqual(['a/first', 'a/second', 'a/third']);
  });

  test('shows at most 10 repos and says how many more there are', () => {
    const spec: Record<string, number> = {};
    for (let i = 0; i < 12; i++) spec[`alrayyes/repo-${i}`] = 1;

    const { top, remaining } = rankByRepo(repos(spec));

    expect(top).toHaveLength(10);
    expect(remaining).toBe(2);
  });

  test('exactly the cap leaves nothing remaining', () => {
    const spec: Record<string, number> = {};
    for (let i = 0; i < 10; i++) spec[`alrayyes/repo-${i}`] = 1;

    expect(rankByRepo(repos(spec)).remaining).toBe(0);
  });

  test('nothing to rank is an empty list, not a crash on the first row', () => {
    expect(rankByRepo([])).toEqual({ top: [], maxCount: 0, remaining: 0 });
  });
});
