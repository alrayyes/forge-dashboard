import { describe, expect, test } from 'bun:test';
import type { NavCounts } from './nav-counts.svelte';
import { applyLiveCi, type CountedPullRequest } from './nav-counts-live';
import type { PullRequestFold } from './pr-fold';

const jobs = {
  passed: 0,
  skipped: 0,
  running: 0,
  waiting: 0,
  failed: 0,
  unknown: 0,
  cancelled: 0,
  held: 0,
  notStarted: 0,
};

const fold = (
  ci: PullRequestFold['ci'],
  over: { awaiting?: boolean; failed?: number; cancelled?: number } = {},
): PullRequestFold => ({
  ci,
  awaiting: over.awaiting ?? false,
  counts: {
    ...jobs,
    failed: over.failed ?? 0,
    cancelled: over.cancelled ?? 0,
  },
});

const pr = (
  number: number,
  over: Partial<CountedPullRequest> = {},
): CountedPullRequest => ({
  forge: 'github',
  repo: 'acme/app',
  number,
  kind: 'regular',
  ci: 'success',
  draft: false,
  ...over,
});

const page = (over: Record<string, number> = {}) => ({
  total: 0,
  failed: 0,
  running: 0,
  passed: 0,
  cancelled: 0,
  noChecks: 0,
  behind: 0,
  ...over,
});

const nav = (over: Partial<NavCounts> = {}): NavCounts => ({
  branches: { total: 1, failed: 0 },
  pullRequests: page({ total: 2, passed: 2 }),
  issues: { total: 3, failed: 0 },
  releases: page(),
  bots: page(),
  ...over,
});

const live = (...entries: [number, PullRequestFold][]) =>
  new Map(entries.map(([n, f]) => [`github:acme/app#${n}`, f]));

describe('applyLiveCi', () => {
  test('moves a pull request from the snapshot number to the live one', () => {
    const before = nav();
    const after = applyLiveCi(
      before,
      [pr(1), pr(2)],
      live([1, fold('pending')]),
    );

    expect(after?.pullRequests).toEqual(
      page({ total: 2, passed: 1, running: 1 }),
    );
    // The server's numbers are left alone, so nothing can add up twice.
    expect(before.pullRequests).toEqual(page({ total: 2, passed: 2 }));
  });

  test('counts a snapshot that has caught up once', () => {
    const caughtUp = nav({
      pullRequests: page({ total: 2, passed: 1, running: 1 }),
    });

    expect(
      applyLiveCi(
        caughtUp,
        [pr(1, { ci: 'pending' }), pr(2)],
        live([1, fold('pending')]),
      ),
    ).toBe(caughtUp);
  });

  test('moves the number of the page that lists the kind', () => {
    const before = nav({
      releases: page({ total: 1, passed: 1 }),
      bots: page({ total: 1, noChecks: 1 }),
    });
    const after = applyLiveCi(
      before,
      [pr(1, { kind: 'release' }), pr(2, { kind: 'dependency', ci: 'none' })],
      live([1, fold('failure', { failed: 1 })], [2, fold('cancelled')]),
    );

    expect(after?.releases).toEqual(page({ total: 1, failed: 1 }));
    expect(after?.bots).toEqual(page({ total: 1, cancelled: 1 }));
    expect(after?.pullRequests).toBe(before.pullRequests);
  });

  test('a run only held for approval is in none of the numbers', () => {
    const after = applyLiveCi(
      nav(),
      [pr(1), pr(2)],
      live([1, fold('failure', { awaiting: true })]),
    );

    expect(after?.pullRequests).toEqual(page({ total: 2, passed: 1 }));
  });

  test('a real failure beside a held run counts as failed', () => {
    const after = applyLiveCi(
      nav({ pullRequests: page({ total: 1 }) }),
      [pr(1, { ci: 'failure', failingCi: false })],
      live([1, fold('failure', { awaiting: true, failed: 1 })]),
    );

    expect(after?.pullRequests).toEqual(page({ total: 1, failed: 1 }));
  });

  test('a cancelled run beside a held one counts as failed', () => {
    const after = applyLiveCi(
      nav({ pullRequests: page({ total: 1 }) }),
      [pr(1, { ci: 'failure', failingCi: false })],
      live([1, fold('failure', { awaiting: true, cancelled: 1 })]),
    );

    expect(after?.pullRequests).toEqual(page({ total: 1, failed: 1 }));
  });

  test('behind follows a bot pull request in and out of passing', () => {
    const behind = pr(1, {
      kind: 'dependency',
      outOfDate: true,
      greenBehindBase: true,
    });
    const going = applyLiveCi(
      nav({ bots: page({ total: 1, passed: 1, behind: 1 }) }),
      [behind],
      live([1, fold('pending')]),
    );
    expect(going?.bots).toEqual(page({ total: 1, running: 1 }));

    const done = applyLiveCi(
      nav({ bots: page({ total: 1, running: 1 }) }),
      [{ ...behind, ci: 'pending', greenBehindBase: false }],
      live([1, fold('success')]),
    );
    expect(done?.bots).toEqual(page({ total: 1, passed: 1, behind: 1 }));
  });

  test('a draft, a hidden one and one the snapshot lacks move nothing', () => {
    const before = nav();

    expect(
      applyLiveCi(
        before,
        [pr(1, { draft: true }), pr(2, { hidden: true })],
        live([1, fold('pending')], [2, fold('pending')], [3, fold('pending')]),
      ),
    ).toBe(before);
  });

  test('unknown counts stay unknown', () => {
    expect(applyLiveCi(null, [pr(1)], live([1, fold('pending')]))).toBeNull();
  });
});
