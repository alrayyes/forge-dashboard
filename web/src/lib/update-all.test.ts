/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { AllowedAction } from './allowed-actions';
import type { AutoUpdate } from './auto-update';
import {
  chosenRows,
  progressLabel,
  showUpdateAll,
  summaryLine,
  updateAllChips,
  updateAllLabel,
  updateAllPlan,
} from './update-all';

// "Update all" on the Pull requests page updates every listed pull request the
// server says can be brought up to date, through the per-row Update branch the
// server offers.

type Row = {
  forge: string;
  repo: string;
  number: number;
  title: string;
  allowedActions?: AllowedAction[];
  autoUpdate?: AutoUpdate;
};

function row(over: Partial<Row> & { number: number }): Row {
  return {
    forge: 'github',
    repo: 'acme/api',
    title: 'fix x',
    allowedActions: [{ action: 'update_branch' }],
    ...over,
  };
}

describe('updateAllPlan', () => {
  test('counts the rows whose Update branch the server offers', () => {
    const plan = updateAllPlan([
      row({ number: 1 }),
      row({ number: 2, allowedActions: [{ action: 'merge' }] }),
      row({ number: 3 }),
    ]);
    expect(plan.eligible.map((r) => r.number)).toEqual([1, 3]);
    expect(plan.total).toBe(3);
  });

  test('leaves out a row whose Update branch is blocked', () => {
    const plan = updateAllPlan([
      row({
        number: 1,
        allowedActions: [
          {
            action: 'update_branch',
            blocked: { code: 'conflicts', message: 'Has conflicts.' },
          },
        ],
      }),
    ]);
    expect(plan.eligible).toEqual([]);
  });

  test('leaves out a row with no allowed actions at all', () => {
    expect(
      updateAllPlan([row({ number: 1, allowedActions: undefined })]),
    ).toEqual({ eligible: [], total: 1 });
  });

  test('leaves out a row whose update is already asked for', () => {
    const plan = updateAllPlan([row({ number: 1 }), row({ number: 2 })], {
      updating: (r) => r.number === 1,
    });
    expect(plan.eligible.map((r) => r.number)).toEqual([2]);
  });
});

describe('updateAllPlan and automatic branch update', () => {
  const auto = (over: Partial<AutoUpdate>): AutoUpdate => ({
    enabled: false,
    source: 'repo',
    unavailable: null,
    ...over,
  });
  const numbers = (autoUpdate?: AutoUpdate) =>
    updateAllPlan([row({ number: 1, autoUpdate })]).eligible.map(
      (r) => r.number,
    );

  test('leaves out a row whose repo keeps it current', () => {
    expect(numbers(auto({ enabled: true, source: 'repo' }))).toEqual([]);
  });

  test('keeps a row the person switched off inside a repo that has it on', () => {
    expect(numbers(auto({ enabled: false, source: 'pullRequest' }))).toEqual([
      1,
    ]);
  });

  test('keeps a row the automatic update skips for a reason', () => {
    const unavailable = { code: 'draft', reason: 'A draft is never updated.' };
    expect(numbers(auto({ unavailable }))).toEqual([1]);
  });

  test('leaves out a row the person switched on themselves', () => {
    expect(numbers(auto({ enabled: true, source: 'pullRequest' }))).toEqual([]);
  });

  test('keeps a row from a server that sends no state', () => {
    expect(numbers(undefined)).toEqual([1]);
  });

  test('counts only the rows left in the total shown as updatable', () => {
    const plan = updateAllPlan([
      row({ number: 1, autoUpdate: auto({ enabled: true }) }),
      row({ number: 2 }),
    ]);
    expect(plan.eligible.map((r) => r.number)).toEqual([2]);
    expect(plan.total).toBe(2);
  });
});

describe('chosenRows', () => {
  const plan = updateAllPlan([
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
    const later = updateAllPlan([row({ number: 1 }), row({ number: 3 })]);
    const chosen = chosenRows(plan.eligible, new Set(), key, later.eligible);
    expect(chosen.map((r) => r.number)).toEqual([1, 3]);
  });
});

describe('labels', () => {
  test('puts the count in the button', () => {
    expect(updateAllLabel(4)).toBe('Update all (4)');
    expect(updateAllLabel(0)).toBe('Update all');
  });

  test('counts how many of the listed rows can be updated', () => {
    expect(summaryLine(1, 6)).toBe('1 of 6 can be updated.');
    expect(summaryLine(4, 6)).toBe('4 of 6 can be updated.');
  });

  test('reads the progress as done of total', () => {
    expect(progressLabel(2, 4)).toBe('Updating 2 of 4');
  });
});

describe('showUpdateAll', () => {
  test('hides when no listed row can be updated', () => {
    const plan = updateAllPlan([row({ number: 1, allowedActions: [] })]);
    expect(showUpdateAll(plan, false)).toBe(false);
  });

  test('hides for an empty list', () => {
    expect(showUpdateAll(updateAllPlan([]), false)).toBe(false);
  });

  test('shows when a listed row can be updated', () => {
    expect(showUpdateAll(updateAllPlan([row({ number: 1 })]), false)).toBe(
      true,
    );
  });

  test('keeps the button while a run is under way', () => {
    const plan = updateAllPlan([row({ number: 1, allowedActions: [] })]);
    expect(showUpdateAll(plan, true)).toBe(true);
  });
});

// The chips on the strip (#3277): what the plan already counts, as words.
describe('updateAllChips', () => {
  const four = () => [
    row({ number: 1 }),
    row({ number: 2 }),
    row({ number: 3 }),
    row({ number: 4, allowedActions: [] }),
  ];

  test('reads the eligible count and the rows listed', () => {
    expect(updateAllChips(updateAllPlan(four()))).toEqual([
      { text: '3 ready to update', tone: 'good' },
      { text: '4 listed' },
    ]);
  });

  test('the ready chip is neutral at zero, as during a run', () => {
    const plan = updateAllPlan([row({ number: 1, allowedActions: [] })]);
    expect(updateAllChips(plan)).toEqual([
      { text: '0 ready to update' },
      { text: '1 listed' },
    ]);
  });

  test('a request already waiting is not ready', () => {
    const plan = updateAllPlan(four(), { updating: (r) => r.number === 1 });
    expect(updateAllChips(plan)[0].text).toBe('2 ready to update');
  });
});
