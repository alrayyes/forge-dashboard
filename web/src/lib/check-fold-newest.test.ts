/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import fixture from '../../../internal/dashboard/testdata/newest_runs.json';
import { foldNewestRuns, newestRuns } from './check-fold';
import type { Check } from './pipeline-checks';

// The rule's cases live in one file the Go tests read too
// (internal/dashboard/testdata/newest_runs.json), so the server and the page
// cannot drift apart.
type FixtureCheck = {
  name: string;
  runName?: string;
  runNumber?: number;
  runAttempt?: number;
  runId?: number;
  jobConclusion?: string;
  runConclusion?: string;
};

const cases = fixture as {
  name: string;
  checks: FixtureCheck[];
  keep: string[];
}[];

const toCheck = (f: FixtureCheck): Check => ({
  name: f.name,
  url: `https://github.com/a/b/actions/runs/${f.runId}/job/${f.name}`,
  status: 'completed',
  conclusion: f.jobConclusion ?? 'success',
  runName: f.runName,
  runNumber: f.runNumber,
  runAttempt: f.runAttempt,
  runId: f.runId,
});

// The run facts a snapshot row carries, one per run that has a conclusion.
const runsOf = (checks: FixtureCheck[]) =>
  checks
    .filter((f) => f.runConclusion)
    .map((f) => ({
      runId: f.runId,
      runAttempt: f.runAttempt,
      conclusion: f.runConclusion,
    }));

const label = (c: Check) =>
  `${c.name}@${c.runName ?? ''}#${c.runNumber ?? 0}.${c.runAttempt ?? 0}`;

function job(
  name: string,
  conclusion: string,
  runName: string | undefined,
  runNumber: number | undefined,
  runAttempt = 1,
): Check {
  return {
    name,
    url: `https://github.com/a/b/actions/runs/${runNumber}/job/${name}`,
    status: 'completed',
    conclusion,
    runName,
    runNumber,
    runAttempt,
    runId: runNumber === undefined ? undefined : runNumber * 10,
  };
}

describe('newestRuns', () => {
  for (const tc of cases) {
    test(tc.name, () => {
      const got = newestRuns(tc.checks.map(toCheck), runsOf(tc.checks));

      expect(got.map(label)).toEqual(tc.keep);
    });
  }

  // A live job carries no run conclusion. With none to read, a run counts as
  // cancelled when every one of its jobs was.
  test('without a run conclusion, a run of only cancelled jobs replaces nothing', () => {
    const checks = [
      job('test', 'failure', 'ci', 1),
      job('test', 'cancelled', 'ci', 2),
    ];

    expect(newestRuns(checks)).toHaveLength(2);
  });

  test('without a run conclusion, a run with one job that finished is newest', () => {
    const checks = [
      job('a', 'failure', 'ci', 1),
      job('lint', 'success', 'ci', 2),
      job('t', 'cancelled', 'ci', 2),
    ];

    expect(newestRuns(checks).map(label)).toEqual(['lint@ci#2.1', 't@ci#2.1']);
  });
});

describe('foldNewestRuns', () => {
  test('a passing newer run clears an older failure', () => {
    const folded = foldNewestRuns([
      job('reports', 'failure', 'ci', 1),
      job('reports', 'success', 'ci', 2),
    ]);

    expect(folded.status).toBe('passed');
    expect(folded.failing).toEqual([]);
  });

  test('a failure of another workflow still fails the row', () => {
    const folded = foldNewestRuns([
      job('reports', 'success', 'ci', 2),
      job('ship', 'failure', 'deploy', 9),
    ]);

    expect(folded.status).toBe('failed');
    expect(folded.failing).toEqual(['ship']);
  });
});
