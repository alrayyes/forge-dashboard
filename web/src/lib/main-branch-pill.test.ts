/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { factsOf } from './check-facts-fixture';
import { foldBranch } from './check-fold';
import { branchPill, type MainBranch } from './main-branches';
import type { Check } from './pipeline-checks';

function jobs(...states: string[]): Check[] {
  return states.map((state, i) => ({
    name: `job ${i}`,
    url: `https://forge.example/run/${i}`,
    ...factsOf(state),
  }));
}

// What the last refresh said about the row: one job failed.
const snapshot: Pick<MainBranch, 'status' | 'checks'> = {
  status: 'failed',
  checks: { passed: 2, running: 0, waiting: 0, failed: 1 },
};

describe('branchPill', () => {
  test('with no dialog open the pill reads the snapshot', () => {
    expect(branchPill(snapshot, null)).toEqual({
      status: 'failed',
      counts: { passed: 2, running: 0, waiting: 0, failed: 1 },
    });
  });

  test('an empty job list is no answer, so the snapshot stands', () => {
    expect(branchPill(snapshot, [])).toEqual(branchPill(snapshot, null));
  });

  // The rerun case: the dialog's list has moved to a running job and the
  // snapshot has not caught up. The pill follows the list the dialog shows.
  test('the pill and the dialog read one job list', () => {
    const list = jobs('success', 'success', 'running');

    expect(branchPill(snapshot, list)).toEqual({
      status: 'running',
      counts: foldBranch(list).counts,
    });
    expect(branchPill(snapshot, list).counts.running).toBe(1);
  });

  test('a list that settles to passed turns the pill to passed', () => {
    expect(branchPill(snapshot, jobs('success', 'success')).status).toBe(
      'passed',
    );
  });

  test('a list of held jobs is waiting for approval', () => {
    expect(branchPill(snapshot, jobs('awaiting_approval')).status).toBe(
      'awaiting_approval',
    );
  });
});
