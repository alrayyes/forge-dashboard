/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  branchNavCount,
  countMainBranches,
  MAIN_BRANCH_STATUSES,
  type MainBranchCounts,
  type MainBranchStatus,
  statusCount,
} from './main-branches';
import { pillParts } from './nav-labels';

// The Branches nav pill and the Main branches page chips are two readings of
// one tally. The page reads /api/v1/main-branches on its own timer and the pill
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
      cancelled: 0,
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

// A status the page can filter by has to land in a part of the pill, or the
// parts stop adding up to the total (#2024, #3958).
describe('every status the page filters by is a part of the pill', () => {
  const statuses = MAIN_BRANCH_STATUSES.filter(
    (s): s is MainBranchStatus => s !== 'all',
  );

  test('one branch of each status: the parts add up to the total', () => {
    const tally = countMainBranches(statuses.map((status) => ({ status })));
    const nav = branchNavCount(tally);
    const parts = pillParts(nav);

    expect(nav.total).toBe(statuses.length);
    expect(parts.reduce((n, p) => n + p.n, 0)).toBe(nav.total);
  });

  for (const status of statuses) {
    test(`a ${status} branch is drawn in the pill`, () => {
      const nav = branchNavCount(countMainBranches([{ status }]));

      expect(pillParts(nav).reduce((n, p) => n + p.n, 0)).toBe(1);
    });
  }
});
