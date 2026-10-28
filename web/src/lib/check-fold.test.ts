/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { factsOf } from './check-facts-fixture';
import { type BranchStatus, foldBranch } from './check-fold';
import type { Check } from './pipeline-checks';

// The states the Go fold tests name their runs by (success, failure,
// cancelled, skipped, running, waiting), as the facts the server sends.
function jobs(...states: string[]): Check[] {
  return states.map((state, i) => ({
    name: `job ${i}`,
    url: `https://forge.example/run/${i}`,
    ...factsOf(state),
  }));
}

// Ports TestReadMainBranch_EachStatus: a real failure wins over a run still
// going, and runs that were only cancelled, with nothing left to replace them,
// are cancelled rather than failed.
describe('foldBranch status', () => {
  const cases: [string, string[], BranchStatus][] = [
    ['success', ['success'], 'passed'],
    ['failure', ['failure'], 'failed'],
    ['cancelled alone', ['cancelled'], 'cancelled'],
    ['cancelled beside a success', ['cancelled', 'success'], 'cancelled'],
    ['cancelled beside a failure', ['cancelled', 'failure'], 'failed'],
    ['cancelled beside a job still going', ['cancelled', 'running'], 'running'],
    ['skipped alone', ['skipped'], 'passed'],
    ['running', ['running'], 'running'],
    ['waiting', ['queued'], 'running'],
    ['failure beside a running job', ['failure', 'running'], 'failed'],
    ['timed out', ['timed_out'], 'failed'],
    ['skipped beside successes', ['success', 'skipped', 'success'], 'passed'],
    ['held alone', ['awaiting_approval'], 'awaiting_approval'],
    [
      'held beside a success',
      ['awaiting_approval', 'success'],
      'awaiting_approval',
    ],
    [
      'held beside a cancelled job',
      ['awaiting_approval', 'cancelled'],
      'awaiting_approval',
    ],
    ['held beside a failure', ['awaiting_approval', 'failure'], 'failed'],
    ['held beside a running job', ['awaiting_approval', 'running'], 'running'],
  ];

  for (const [name, states, want] of cases) {
    test(name, () => {
      expect(foldBranch(jobs(...states)).status).toBe(want);
    });
  }

  test('a conclusion the page does not know reads as a failure', () => {
    const odd: Check = {
      name: 'odd',
      url: '',
      status: 'completed',
      conclusion: 'startup_failure',
    };

    expect(foldBranch([odd]).status).toBe('failed');
  });

  // Go reads a status it does not know as queued, so a job the page cannot
  // grade is neither passed nor silently dropped.
  test('a status the page does not know reads as waiting', () => {
    const odd: Check = { name: 'odd', url: '', status: 'pending' };

    expect(foldBranch([odd]).status).toBe('running');
    expect(foldBranch([odd]).counts.waiting).toBe(1);
  });

  test('no jobs is none, not passed', () => {
    expect(foldBranch([]).status).toBe('none');
  });
});

// Ports TestReadMainBranch_FallsBackToTheRunCounts: skipped sits inside passed,
// queued and blocked jobs wait, and a cancelled job is in none of the four.
describe('foldBranch counts', () => {
  test('mixed', () => {
    expect(
      foldBranch(
        jobs('success', 'skipped', 'running', 'queued', 'queued', 'failure'),
      ).counts,
    ).toEqual({ passed: 2, skipped: 1, running: 1, waiting: 2, failed: 1 });
  });

  test('every job skipped', () => {
    expect(foldBranch(jobs('skipped', 'skipped')).counts).toEqual({
      passed: 2,
      skipped: 2,
      running: 0,
      waiting: 0,
      failed: 0,
    });
  });

  test('all passed', () => {
    expect(foldBranch(jobs('success', 'success', 'success')).counts).toEqual({
      passed: 3,
      skipped: 0,
      running: 0,
      waiting: 0,
      failed: 0,
    });
  });

  test('cancelled counts in none', () => {
    expect(foldBranch(jobs('success', 'cancelled')).counts).toEqual({
      passed: 1,
      skipped: 0,
      running: 0,
      waiting: 0,
      failed: 0,
    });
  });

  test('a held job is in none of the four', () => {
    expect(foldBranch(jobs('success', 'awaiting_approval')).counts).toEqual({
      passed: 1,
      skipped: 0,
      running: 0,
      waiting: 0,
      failed: 0,
    });
  });

  test('a timed-out job counts as failed', () => {
    expect(foldBranch(jobs('timed_out')).counts.failed).toBe(1);
  });

  test('no jobs is all zero', () => {
    expect(foldBranch([]).counts).toEqual({
      passed: 0,
      skipped: 0,
      running: 0,
      waiting: 0,
      failed: 0,
    });
  });
});

// The names the Failing: line lists: the jobs the counts call failed, in the
// order the forge listed them, and none when nothing failed.
describe('foldBranch failing jobs', () => {
  test('names each failed job and no other', () => {
    const list = jobs('success', 'failure', 'running', 'timed_out');

    expect(foldBranch(list).failing).toEqual(['job 1', 'job 3']);
  });

  test('is empty when nothing failed', () => {
    expect(foldBranch(jobs('success', 'running')).failing).toEqual([]);
    expect(foldBranch([]).failing).toEqual([]);
  });

  test('a cancelled or held job is not failing', () => {
    expect(foldBranch(jobs('cancelled', 'awaiting_approval')).failing).toEqual(
      [],
    );
  });

  test('agrees with the failed count', () => {
    const list = jobs('failure', 'failure', 'success');
    const { counts, failing } = foldBranch(list);

    expect(failing).toHaveLength(counts.failed);
  });
});
