/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  branchNavCount,
  countMainBranches,
  type MainBranch,
  type MainBranchStatus,
} from './main-branches';

// The server sends rows, not tallies: the pills and the nav badge both read
// this one count of the rows the page holds (#2886).

const rows = (...statuses: MainBranchStatus[]) =>
  statuses.map((status) => ({ status }) as unknown as MainBranch);

describe('countMainBranches', () => {
  test('counts add up to the total, a cancelled branch apart from the failed ones', () => {
    expect(
      countMainBranches(
        rows('none', 'passed', 'running', 'failed', 'failed', 'cancelled'),
      ),
    ).toEqual({
      failed: 2,
      passed: 1,
      running: 1,
      cancelled: 1,
      awaitingApproval: 0,
      none: 1,
      total: 6,
    });
  });

  test('a branch held for approval is counted on its own, not as having no pipeline', () => {
    const counts = countMainBranches(
      rows('passed', 'running', 'awaiting_approval', 'awaiting_approval'),
    );

    expect(counts.awaitingApproval).toBe(2);
    expect(counts.none).toBe(0);
    expect(counts.total).toBe(4);
  });

  test('no rows is a tally of zeros', () => {
    expect(countMainBranches([])).toEqual({
      failed: 0,
      passed: 0,
      running: 0,
      cancelled: 0,
      awaitingApproval: 0,
      none: 0,
      total: 0,
    });
  });

  test('an unknown status counts as having no pipeline', () => {
    expect(
      countMainBranches(rows('mystery' as unknown as MainBranchStatus)).none,
    ).toBe(1);
  });

  test('the nav pill carries every chip of the tally', () => {
    expect(
      branchNavCount(
        countMainBranches(rows('passed', 'running', 'awaiting_approval')),
      ),
    ).toEqual({
      total: 3,
      failed: 0,
      passed: 1,
      running: 1,
      none: 0,
      awaitingApproval: 1,
    });
  });
});
