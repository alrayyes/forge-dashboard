/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { factsOf } from './check-facts-fixture';
import { foldBranch } from './check-fold';
import {
  branchKey,
  branchPill,
  countMainBranches,
  type MainBranch,
  withLiveJobs,
} from './main-branches';
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

function row(fullName: string, status: MainBranch['status']): MainBranch {
  return {
    forge: 'forgejo',
    fullName,
    branch: 'main',
    status,
    checks: { passed: 0, running: 0, waiting: 0, failed: 0 },
  } as MainBranch;
}

describe('withLiveJobs', () => {
  const rows = [row('a/one', 'failed'), row('a/two', 'failed')];
  const key = branchKey(rows[0]);

  test('with no job list the rows are the refresh', () => {
    expect(withLiveJobs(rows, null)).toEqual(rows);
  });

  test('an empty job list is no answer', () => {
    expect(withLiveJobs(rows, { key, checks: [] })).toEqual(rows);
  });

  test('the open row takes the fold and the others stay as refreshed', () => {
    const live = { key, checks: jobs('success', 'running') };
    const out = withLiveJobs(rows, live);

    expect(out[0].status).toBe('running');
    expect(out[0].checks).toEqual(foldBranch(live.checks).counts);
    expect(out[1]).toBe(rows[1]);
  });

  // The chips and the header pill count rows: they must agree with the pill.
  test('the tally counts the open row by its live status', () => {
    const live = { key, checks: jobs('success', 'success') };

    expect(countMainBranches(rows).failed).toBe(2);
    expect(countMainBranches(withLiveJobs(rows, live))).toMatchObject({
      failed: 1,
      passed: 1,
    });
  });

  test('a key that matches no row changes nothing', () => {
    const live = {
      key: branchKey(row('a/gone', 'failed')),
      checks: jobs('success'),
    };

    expect(withLiveJobs(rows, live)).toEqual(rows);
  });
});
