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
    behind: 0,
  });
  expect(counts.bots.noChecks).toBe(0);
  expect(counts.releases.noChecks).toBe(0);
});

// Behind is a note on passed, not a part of the total (#4282, #4629). Only a
// green bot pull request that is behind its base with something left to merge
// raises it, as the server counts it.

test('a green bot pull request behind its base raises behind beside passed (#4629)', () => {
  const counts = navCountsFor(
    [{ kind: 'dependency', ci: 'success', behindBase: true }],
    0,
  );

  expect(counts.bots).toEqual({
    total: 1,
    running: 0,
    failed: 0,
    passed: 1,
    cancelled: 0,
    noChecks: 0,
    behind: 1,
  });
  expect(counts.pullRequests.behind).toBe(0);
});

test('a draft, failing, hidden, empty or non-bot pull request behind its base counts no behind (#4629)', () => {
  const counts = navCountsFor(
    [
      { kind: 'dependency', ci: 'success', behindBase: true, draft: true },
      { kind: 'dependency', ci: 'failure', behindBase: true },
      { kind: 'dependency', ci: 'success', behindBase: true, hidden: true },
      { kind: 'dependency', ci: 'success', behindBase: true, empty: true },
      { kind: 'regular', ci: 'success', behindBase: true },
      { kind: 'release', ci: 'success', behindBase: true },
    ],
    0,
  );

  expect(counts.bots.behind).toBe(0);
  expect(counts.pullRequests.behind).toBe(0);
  expect(counts.releases.behind).toBe(0);
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
    behind: 0,
  });
});
