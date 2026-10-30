/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { branchPill, type MainBranch, withSnapshotRuns } from './main-branches';
import type { Check } from './pipeline-checks';

function job(conclusion: string, runNumber: number): Check {
  return {
    name: 'reports',
    url: `https://github.com/a/b/actions/runs/${runNumber}/job/1`,
    status: 'completed',
    conclusion,
    runName: 'ci',
    runNumber,
    runAttempt: 1,
  };
}

// A row whose first run of ci failed and whose second passed: the server's
// status still says failed, as an older client or a cut-short read would.
describe('a default branch row with an older failed run', () => {
  const row = {
    status: 'failed',
    checks: { passed: 1, skipped: 0, running: 0, waiting: 0, failed: 1 },
    failingJobs: ['reports'],
    runs: [
      { runId: 10, runAttempt: 1, checks: [job('failure', 1)] },
      { runId: 20, runAttempt: 1, checks: [job('success', 2)] },
    ],
  } as unknown as MainBranch;

  test('the snapshot reads passed, as the newest run did', () => {
    const [out] = withSnapshotRuns([row]);

    expect([out.status, out.failingJobs]).toEqual(['passed', []]);
  });

  test('a live job list reads the same', () => {
    const live = (row.runs ?? []).flatMap((run) => run.checks);

    expect(branchPill(row, live).status).toBe('passed');
  });
});
