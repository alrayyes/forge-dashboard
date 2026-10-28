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
const snapshot: Pick<MainBranch, 'status' | 'checks' | 'failingJobs'> = {
  status: 'failed',
  checks: { passed: 2, running: 0, waiting: 0, failed: 1 },
  failingJobs: ['secrets'],
};

describe('branchPill', () => {
  test('with no dialog open the pill reads the snapshot', () => {
    expect(branchPill(snapshot, null)).toEqual({
      status: 'failed',
      counts: { passed: 2, running: 0, waiting: 0, failed: 1 },
      failing: ['secrets'],
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
      failing: [],
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
    failingJobs: status === 'failed' ? ['secrets'] : [],
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

  // The Failing: line names the jobs that failed. After a rerun the list says
  // none did, so the line must not keep naming last run's.
  test('the open row names the jobs its live list failed', () => {
    const rerun = { key, checks: jobs('success', 'running') };
    const failed = { key, checks: jobs('success', 'failure') };

    expect(rows[0].failingJobs).toEqual(['secrets']);
    expect(withLiveJobs(rows, rerun)[0].failingJobs).toEqual([]);
    expect(withLiveJobs(rows, failed)[0].failingJobs).toEqual(['job 1']);
    expect(withLiveJobs(rows, failed)[1]).toBe(rows[1]);
  });

  test('an empty list leaves the names as refreshed', () => {
    expect(withLiveJobs(rows, { key, checks: [] })[0].failingJobs).toEqual([
      'secrets',
    ]);
  });

  test('a key that matches no row changes nothing', () => {
    const live = {
      key: branchKey(row('a/gone', 'failed')),
      checks: jobs('success'),
    };

    expect(withLiveJobs(rows, live)).toEqual(rows);
  });
});
