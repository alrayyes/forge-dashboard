/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { foldNewestRuns, newestRuns } from './check-fold';
import type { Check } from './pipeline-checks';

// Ports TestNewestRuns_* (internal/dashboard/newest_runs_test.go): a newer run
// of a workflow replaces the older one, and the pill reads only the newest.
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
  };
}

describe('newestRuns', () => {
  test('a newer run of the same workflow replaces the older', () => {
    const checks = [
      job('reports', 'failure', 'ci', 1),
      job('lint', 'success', 'ci', 1),
      job('reports', 'success', 'ci', 2),
      job('scan', 'success', 'gitleaks', 1),
    ];

    expect(newestRuns(checks).map((c) => `${c.name}@${c.runNumber}`)).toEqual([
      'reports@2',
      'scan@1',
    ]);
  });

  test('a later attempt of the same run replaces the earlier', () => {
    const checks = [
      job('test', 'failure', 'ci', 1, 1),
      job('test', 'success', 'ci', 1, 2),
    ];

    expect(newestRuns(checks).map((c) => c.runAttempt)).toEqual([2]);
  });

  test('a run that was only cancelled replaces nothing', () => {
    const checks = [
      job('test', 'failure', 'ci', 1),
      job('test', 'cancelled', 'ci', 2),
    ];

    expect(newestRuns(checks)).toHaveLength(2);
  });

  test('checks with no workflow or run number are kept', () => {
    const checks = [
      job('codecov', 'success', undefined, undefined),
      job('codecov', 'failure', undefined, undefined),
    ];

    expect(newestRuns(checks)).toHaveLength(2);
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
