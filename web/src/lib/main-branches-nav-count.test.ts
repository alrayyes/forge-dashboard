/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { branchNavCount, type MainBranchCounts } from './main-branches';

// The Branches nav pill and the Main branches page chips are two readings of
// one tally. The page reads /api/main-branches on its own timer and the pill
// reads the dashboard snapshot on another, so a branch that went from running
// to failed between the two showed on the page first. The page now hands the
// pill its own counts, drawn through this one function.
// https://github.com/alrayyes/forge-dashboard/issues/2579

const counts: MainBranchCounts = {
  total: 76,
  failed: 2,
  passed: 64,
  running: 4,
  cancelled: 0,
  awaitingApproval: 0,
  none: 6,
};

describe('branchNavCount', () => {
  test('carries every chip of the page into the pill', () => {
    expect(branchNavCount(counts)).toEqual({
      total: 76,
      failed: 2,
      passed: 64,
      running: 4,
      none: 6,
      awaitingApproval: 0,
    });
  });
});
