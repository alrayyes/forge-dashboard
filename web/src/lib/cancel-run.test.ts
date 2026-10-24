/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import {
  activeRuns,
  cancelLocksRepo,
  cancelRun,
  cancelText,
  runStopped,
} from './cancel-run';
import type { Check } from './pipeline-checks';

const job = (over: Partial<Check>): Check => ({
  name: 'build',
  jobId: 1,
  state: 'running',
  url: '',
  ...over,
});

describe('activeRuns', () => {
  test('groups the running jobs under their run, in first-seen order', () => {
    const runs = activeRuns([
      job({ name: 'lint', runId: 7, runName: 'ci' }),
      job({ name: 'e2e', runId: 9, runName: 'release', state: 'queued' }),
      job({ name: 'test', runId: 7, runName: 'ci', state: 'queued' }),
    ]);

    expect(runs).toEqual([
      {
        runId: 7,
        runName: 'ci',
        runNumber: 0,
        label: 'ci',
        jobs: ['lint', 'test'],
        jobIds: [1, 1],
      },
      {
        runId: 9,
        runName: 'release',
        runNumber: 0,
        label: 'release',
        jobs: ['e2e'],
        jobIds: [1],
      },
    ]);
  });

  test('offers nothing for a job without a run (external CI, finished)', () => {
    expect(
      activeRuns([job({}), job({ state: 'success', runId: 7, runName: 'ci' })]),
    ).toEqual([]);
  });

  test('names only the unfinished jobs, which are the ones that stop', () => {
    const runs = activeRuns([
      job({ name: 'lint', runId: 7, runName: 'ci' }),
      job({ name: 'build', state: 'success', runId: 7, runName: 'ci' }),
    ]);

    expect(runs[0]?.jobs).toEqual(['lint']);
  });
});

describe('a run whose jobs the forge could not list', () => {
  test('is still cancellable but names no job, not its own title as one', () => {
    // Forgejo stands in one check named for the run when it can't read the
    // jobs; it has a run id and no job id.
    const runs = activeRuns([
      job({ name: 'ci', jobId: undefined, runId: 7, runName: 'ci' }),
    ]);

    expect(runs).toEqual([
      {
        runId: 7,
        runName: 'ci',
        runNumber: 0,
        label: 'ci',
        jobs: [],
        jobIds: [],
      },
    ]);
  });

  test('a job that shares the workflow name still counts as a job', () => {
    const runs = activeRuns([
      job({ name: 'ci', jobId: 5, runId: 7, runName: 'ci' }),
    ]);

    expect(runs[0]?.jobs).toEqual(['ci']);
  });
});

describe('run labels', () => {
  const labels = (checks: Check[]) => activeRuns(checks).map(cancelText);

  test('a lone unnamed run needs no name', () => {
    expect(labels([job({ runId: 7 })])).toEqual(['Cancel run']);
  });

  test('a lone named run is named', () => {
    expect(labels([job({ runId: 7, runName: 'ci' })])).toEqual([
      'Cancel run: ci',
    ]);
  });

  test('several unnamed runs are told apart by number', () => {
    expect(
      labels([
        job({ jobId: 1, runId: 7, runNumber: 614 }),
        job({ jobId: 2, runId: 8, runNumber: 615 }),
        job({ jobId: 3, runId: 9 }),
      ]),
    ).toEqual([
      'Cancel run: run #614',
      'Cancel run: run #615',
      'Cancel run: run #9',
    ]);
  });

  test('runs of distinct workflows keep just the workflow name', () => {
    expect(
      labels([
        job({ jobId: 1, runId: 7, runName: 'ci', runNumber: 5 }),
        job({ jobId: 2, runId: 8, runName: 'release', runNumber: 6 }),
      ]),
    ).toEqual(['Cancel run: ci', 'Cancel run: release']);
  });

  test('runs of one workflow get their number', () => {
    expect(
      labels([
        job({ jobId: 1, runId: 7, runName: 'ci', runNumber: 5 }),
        job({ jobId: 2, runId: 8, runName: 'ci', runNumber: 6 }),
        job({ jobId: 3, runId: 9, runName: 'release', runNumber: 7 }),
      ]),
    ).toEqual([
      'Cancel run: ci #5',
      'Cancel run: ci #6',
      'Cancel run: release',
    ]);
  });
});

describe('cancelRun', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  test('posts the run and resolves on 204', async () => {
    let seen: { url: string; body: unknown } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await cancelRun({ forge: 'github', fullName: 'a/b' }, 7);

    expect(seen).toEqual({
      url: '/api/checks/cancel-run',
      body: { forge: 'github', fullName: 'a/b', runId: 7 },
    });
  });
});

describe('cancelLocksRepo', () => {
  test('a missing permission locks every run of the repository', () => {
    expect(cancelLocksRepo({ code: 'permission' })).toBe(true);
    expect(cancelLocksRepo({ code: 'conflict' })).toBe(false);
    expect(cancelLocksRepo({})).toBe(false);
  });
});

describe('runStopped', () => {
  const run = {
    runId: 7,
    runName: 'ci',
    runNumber: 0,
    label: 'ci',
    jobs: ['lint', 'test'],
    jobIds: [2, 3],
  };

  test('is true once every job it had is listed and finished', () => {
    expect(
      runStopped(run, [
        job({ jobId: 2, state: 'cancelled' }),
        job({ jobId: 3, state: 'cancelled' }),
      ]),
    ).toBe(true);
  });

  test('is false while a job of it is still going, even with no run id', () => {
    // GitHub's run lookup failed: the jobs are listed running, nameless.
    expect(
      runStopped(run, [
        job({ jobId: 2, state: 'running' }),
        job({ jobId: 3, state: 'cancelled' }),
      ]),
    ).toBe(false);
  });

  test('is false while a listed job is going, though another is not listed', () => {
    expect(runStopped(run, [job({ jobId: 2, state: 'running' })])).toBe(false);
  });

  test('is false on an empty list, which says nothing about the run', () => {
    expect(runStopped(run, [])).toBe(false);
    expect(runStopped({ ...run, jobIds: [] }, [])).toBe(false);
  });

  test('is true when none of its jobs is listed any more, a new push replaced them', () => {
    expect(runStopped(run, [job({ jobId: 99, state: 'running' })])).toBe(true);
  });

  test('is false while any check still names the run as going', () => {
    expect(
      runStopped(run, [
        job({ jobId: 99, runId: 7, runName: 'ci', state: 'running' }),
      ]),
    ).toBe(false);
  });

  test('a stand-in that vanished because its jobs became readable and run is not stopped', () => {
    const standIn = {
      runId: 9,
      runName: 'ci',
      runNumber: 0,
      label: 'ci',
      jobs: [],
      jobIds: [],
    };
    expect(
      runStopped(standIn, [
        job({ jobId: 40, runId: 9, runName: 'ci', state: 'running' }),
      ]),
    ).toBe(false);
  });

  test('a stand-in run is stopped when its one check finished', () => {
    const standIn = {
      runId: 9,
      runName: 'ci',
      runNumber: 0,
      label: 'ci',
      jobs: [],
      jobIds: [],
    };
    expect(
      runStopped(standIn, [
        job({ name: 'ci', jobId: undefined, state: 'cancelled' }),
      ]),
    ).toBe(true);
    expect(
      runStopped(standIn, [
        job({ name: 'ci', jobId: undefined, state: 'running' }),
      ]),
    ).toBe(false);
  });
});
