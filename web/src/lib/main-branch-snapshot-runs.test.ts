/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { factsOf } from './check-facts-fixture';
import { foldBranch } from './check-fold';
import {
  branchKey,
  countMainBranches,
  type MainBranch,
  type MainBranchRun,
  withLiveJobs,
  withSnapshotRuns,
} from './main-branches';
import type { Check } from './pipeline-checks';

function jobs(...states: string[]): Check[] {
  return states.map((state, i) => ({
    name: `job ${i}`,
    url: `https://forge.example/run/${i}`,
    ...factsOf(state),
  }));
}

const run = (runId: number, ...states: string[]): MainBranchRun => ({
  runId,
  runAttempt: 1,
  checks: jobs(...states),
});

// A row whose refresh said failed, while its runs say otherwise.
function row(fullName: string, runs?: MainBranchRun[]): MainBranch {
  return {
    forge: 'forgejo',
    fullName,
    branch: 'main',
    status: 'failed',
    checks: { passed: 2, running: 0, waiting: 0, failed: 1 },
    failingJobs: ['secrets'],
    ...(runs ? { runs } : {}),
  } as MainBranch;
}

describe('withSnapshotRuns', () => {
  test('a row with no runs is the refresh, untouched', () => {
    const rows = [row('a/one')];

    expect(withSnapshotRuns(rows)[0]).toBe(rows[0]);
  });

  test('a row with an empty runs list is the refresh, untouched', () => {
    const rows = [row('a/one', [])];

    expect(withSnapshotRuns(rows)[0]).toBe(rows[0]);
  });

  test('the pill, counts and Failing: names fold the runs', () => {
    const runs = [run(1, 'success', 'failure'), run(2, 'running')];
    const [out] = withSnapshotRuns([row('a/one', runs)]);
    const folded = foldBranch(runs.flatMap((r) => r.checks));

    expect(out.status).toBe('failed');
    expect(out.checks).toEqual(folded.counts);
    expect(out.failingJobs).toEqual(folded.failing);
  });

  test('a stale refresh status loses to the runs', () => {
    const [out] = withSnapshotRuns([row('a/one', [run(1, 'success')])]);

    expect(out.status).toBe('passed');
    expect(out.failingJobs).toEqual([]);
  });

  test('the other fields and the runs stay on the row', () => {
    const runs = [run(1, 'running')];
    const [out] = withSnapshotRuns([row('a/one', runs)]);

    expect(out.fullName).toBe('a/one');
    expect(out.runs).toBe(runs);
  });

  test('rows keep their order', () => {
    const rows = [row('a/one', [run(1, 'running')]), row('a/two')];

    expect(withSnapshotRuns(rows).map((r) => r.fullName)).toEqual([
      'a/one',
      'a/two',
    ]);
  });

  test('the chips count the folded rows', () => {
    const rows = [row('a/one', [run(1, 'success')]), row('a/two')];

    expect(countMainBranches(rows).failed).toBe(2);
    expect(countMainBranches(withSnapshotRuns(rows))).toMatchObject({
      failed: 1,
      passed: 1,
    });
  });

  // A watched row's live list replaces the snapshot's list for that row only.
  test('a live list wins over the snapshot runs for its row alone', () => {
    const rows = withSnapshotRuns([
      row('a/one', [run(1, 'failure')]),
      row('a/two', [run(2, 'failure')]),
    ]);
    const live = new Map([[branchKey(rows[0]), jobs('success', 'running')]]);
    const out = withLiveJobs(rows, live);

    expect(out[0].status).toBe('running');
    expect(out[1]).toBe(rows[1]);
    expect(out[1].status).toBe('failed');
  });
});
