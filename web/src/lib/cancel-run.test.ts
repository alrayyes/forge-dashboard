/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { activeRuns, cancelLocksRepo, cancelRun, runLabel } from './cancel-run';
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
      { runId: 7, runName: 'ci', jobs: ['lint', 'test'] },
      { runId: 9, runName: 'release', jobs: ['e2e'] },
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

    expect(runs).toEqual([{ runId: 7, runName: 'ci', jobs: [] }]);
  });

  test('a job that shares the workflow name still counts as a job', () => {
    const runs = activeRuns([
      job({ name: 'ci', jobId: 5, runId: 7, runName: 'ci' }),
    ]);

    expect(runs[0]?.jobs).toEqual(['ci']);
  });
});

describe('runLabel', () => {
  test('names the workflow, and falls back to a plain word', () => {
    expect(runLabel({ runId: 1, runName: 'ci', jobs: [] })).toBe('ci');
    expect(runLabel({ runId: 1, runName: '', jobs: [] })).toBe('this run');
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
