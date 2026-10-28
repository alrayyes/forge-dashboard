/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { factsOf } from './check-facts-fixture';
import type { Check } from './pipeline-checks';
import { foldPullRequest, type PullRequestFold } from './pr-fold';

function jobs(...states: string[]): Check[] {
  return states.map((state, i) => ({
    name: `job ${i}`,
    url: `https://forge.example/run/${i}`,
    ...factsOf(state),
  }));
}

// The pill a pull request draws is pending, failure or success, with a held
// job as its own flag. The branch fold's statuses map onto that.
describe('foldPullRequest ci', () => {
  const cases: [string, string[], PullRequestFold['ci']][] = [
    ['success', ['success'], 'success'],
    ['skipped beside successes', ['success', 'skipped'], 'success'],
    ['failure', ['failure'], 'failure'],
    ['timed out', ['timed_out'], 'failure'],
    ['failure beside a running job', ['failure', 'running'], 'failure'],
    ['running', ['running'], 'pending'],
    ['waiting', ['queued'], 'pending'],
    ['cancelled beside a job still going', ['cancelled', 'running'], 'pending'],
    ['held alone', ['awaiting_approval'], 'pending'],
    ['held beside a success', ['awaiting_approval', 'success'], 'pending'],
  ];

  for (const [name, states, want] of cases) {
    test(name, () => {
      expect(foldPullRequest(jobs(...states))?.ci).toBe(want);
    });
  }
});

describe('foldPullRequest awaiting approval', () => {
  test('a held job sets the flag', () => {
    expect(foldPullRequest(jobs('awaiting_approval'))?.awaiting).toBe(true);
  });

  test('a failure outranks the held job and clears the flag', () => {
    expect(
      foldPullRequest(jobs('awaiting_approval', 'failure'))?.awaiting,
    ).toBe(false);
  });

  test('nothing held leaves it off', () => {
    expect(foldPullRequest(jobs('success'))?.awaiting).toBe(false);
  });
});

// GitHub reads a cancelled-only run as failed, Forgejo's pull request path as
// none or success, and the branch fold as cancelled. The page cannot tell
// which the row wants, so it does not decide: the server's pill stands.
describe('foldPullRequest leaves to the server', () => {
  test('no jobs', () => {
    expect(foldPullRequest([])).toBeNull();
  });

  test('cancelled alone', () => {
    expect(foldPullRequest(jobs('cancelled'))).toBeNull();
  });

  test('cancelled beside a success', () => {
    expect(foldPullRequest(jobs('cancelled', 'success'))).toBeNull();
  });
});

describe('foldPullRequest counts', () => {
  test('are the branch fold counts', () => {
    expect(
      foldPullRequest(
        jobs('success', 'skipped', 'running', 'queued', 'failure'),
      )?.counts,
    ).toEqual({ passed: 2, skipped: 1, running: 1, waiting: 1, failed: 1 });
  });
});
