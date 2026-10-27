/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  branchNavCount,
  countMainBranches,
  type MainBranchCounts,
  statusCount,
} from './main-branches';

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

describe('a row and the pills that count it', () => {
  // A rerun leaves a row read mid-run: one failing row among passed ones. The
  // nav pill, the page's Failed chip and the row's own status are one fact.
  const rows = [
    { status: 'failed' },
    { status: 'passed' },
    { status: 'running' },
  ] as const;

  test('the nav pill and the page chip count the failed row alike', () => {
    const tally = countMainBranches(rows);

    expect(branchNavCount(tally).failed).toBe(statusCount(tally, 'failed'));
  });

  test('both count exactly the rows whose status is failed', () => {
    const tally = countMainBranches(rows);

    expect(branchNavCount(tally).failed).toBe(
      rows.filter((r) => r.status === 'failed').length,
    );
  });
});
