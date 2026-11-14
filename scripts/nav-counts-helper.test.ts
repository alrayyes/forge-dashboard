/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { navCountsFor } from '../tests/nav-counts-helper';

// The helper adds up the generated table. A pull request with no checks has
// its own number (#3241), so the sum has to carry it, and every page's four
// numbers start at zero.

test('a pull request without checks raises noChecks, not a number that is missing (#3241)', () => {
  const counts = navCountsFor([{ ci: 'none' }, { ci: 'failure' }], 0);

  expect(counts.pullRequests).toEqual({
    total: 2,
    running: 0,
    failed: 1,
    passed: 0,
    cancelled: 0,
    noChecks: 1,
  });
  expect(counts.bots.noChecks).toBe(0);
  expect(counts.releases.noChecks).toBe(0);
});

test('a cancelled pull request raises cancelled and sits in its own part (#3967)', () => {
  const counts = navCountsFor([{ ci: 'cancelled' }, { ci: 'failure' }], 0);

  expect(counts.pullRequests).toEqual({
    total: 2,
    running: 0,
    failed: 1,
    passed: 0,
    cancelled: 1,
    noChecks: 0,
  });
});
