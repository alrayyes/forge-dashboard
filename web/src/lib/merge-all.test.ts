/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { AllowedAction } from './allowed-actions';
import {
  branchNote,
  chosenRows,
  mergeAllLabel,
  mergeAllPlan,
  progressLabel,
  summaryLine,
} from './merge-all';

// "Merge all" on the Pull requests page merges every listed pull request the
// server says can merge now, through the per-row Merge the server offers.

type Row = {
  forge: string;
  repo: string;
  number: number;
  title: string;
  allowedActions?: AllowedAction[];
};

function row(over: Partial<Row> & { number: number }): Row {
  return {
    forge: 'github',
    repo: 'acme/api',
    title: 'fix x',
    allowedActions: [{ action: 'merge' }],
    ...over,
  };
}

describe('mergeAllPlan', () => {
  test('counts the rows whose Merge the server offers', () => {
    const plan = mergeAllPlan([
      row({ number: 1 }),
      row({ number: 2, allowedActions: [{ action: 'close' }] }),
      row({ number: 3 }),
    ]);
    expect(plan.eligible.map((r) => r.number)).toEqual([1, 3]);
    expect(plan.total).toBe(3);
  });

  test('leaves out a row whose Merge is blocked', () => {
    const plan = mergeAllPlan([
      row({
        number: 1,
        allowedActions: [
          {
            action: 'merge',
            blocked: { code: 'conflicts', message: 'Has conflicts.' },
          },
        ],
      }),
    ]);
    expect(plan.eligible).toEqual([]);
  });

  test('leaves out a row with no allowed actions at all', () => {
    expect(
      mergeAllPlan([row({ number: 1, allowedActions: undefined })]),
    ).toEqual({ eligible: [], total: 1 });
  });

  test('leaves out a row already being merged', () => {
    const plan = mergeAllPlan([row({ number: 1 }), row({ number: 2 })], {
      merging: (r) => r.number === 1,
    });
    expect(plan.eligible.map((r) => r.number)).toEqual([2]);
  });
});

describe('chosenRows', () => {
  const plan = mergeAllPlan([
    row({ number: 1 }),
    row({ number: 2, repo: 'acme/web' }),
    row({ number: 3 }),
  ]);
  const key = (r: Row) => `${r.repo}#${r.number}`;

  test('keeps every row when none is left out', () => {
    expect(
      chosenRows(plan.eligible, new Set(), key).map((r) => r.number),
    ).toEqual([1, 2, 3]);
  });

  test('drops a row the person left out', () => {
    const left = new Set(['acme/web#2']);
    expect(chosenRows(plan.eligible, left, key).map((r) => r.number)).toEqual([
      1, 3,
    ]);
  });

  test('drops a row that stopped being eligible since the confirm opened', () => {
    const later = mergeAllPlan([row({ number: 1 }), row({ number: 3 })]);
    const chosen = chosenRows(plan.eligible, new Set(), key, later.eligible);
    expect(chosen.map((r) => r.number)).toEqual([1, 3]);
  });
});

describe('labels', () => {
  test('puts the count in the button', () => {
    expect(mergeAllLabel(4)).toBe('Merge all (4)');
    expect(mergeAllLabel(0)).toBe('Merge all');
  });

  test('says nothing is ready when nothing is', () => {
    expect(summaryLine(0, 6)).toBe('Nothing is ready to merge.');
    expect(summaryLine(1, 6)).toBe('1 of 6 is ready to merge.');
    expect(summaryLine(4, 6)).toBe('4 of 6 are ready to merge.');
  });

  test('reads the progress as done of total', () => {
    expect(progressLabel(2, 4)).toBe('Merging 2 of 4');
  });
});

describe('branchNote', () => {
  test('says nothing when the branch was deleted', () => {
    expect(branchNote({ outcome: 'deleted' })).toBeUndefined();
  });

  test('says nothing when the answer carries no branch outcome', () => {
    expect(branchNote(undefined)).toBeUndefined();
  });

  test('says why a branch was kept', () => {
    expect(branchNote({ outcome: 'skipped', reason: 'protected' })).toBe(
      'Branch kept: it is protected.',
    );
    expect(branchNote({ outcome: 'skipped', reason: 'fork' })).toBe(
      'Branch kept: it lives in a fork.',
    );
    expect(branchNote({ outcome: 'skipped', reason: 'default_branch' })).toBe(
      'Branch kept: it is the default branch.',
    );
  });

  test('keeps the branch for a reason it has no words for', () => {
    expect(branchNote({ outcome: 'skipped', reason: 'something_new' })).toBe(
      'Branch kept.',
    );
    expect(branchNote({ outcome: 'skipped' })).toBe('Branch kept.');
  });

  test('says the branch could not be deleted when deleting failed', () => {
    expect(branchNote({ outcome: 'failed' })).toBe(
      'Merged, but the branch could not be deleted.',
    );
  });
});
