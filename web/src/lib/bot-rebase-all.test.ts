/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { AllowedAction } from './allowed-actions';
import {
  progressLabel,
  rebaseAllLabel,
  rebaseAllPlan,
  showRebaseAll,
  summaryLine,
} from './bot-rebase-all';

// "Rebase all" on the Bots page asks every listed, out-of-date bot pull
// request to rebase, through the per-row actions the server already offers.

type Row = {
  forge: string;
  repo: string;
  number: number;
  title: string;
  behind?: boolean;
  empty?: boolean;
  ci?: string;
  failingCi?: boolean;
  allowedActions?: AllowedAction[];
};

function row(over: Partial<Row> & { number: number }): Row {
  return {
    forge: 'github',
    repo: 'acme/api',
    title: 'bump x',
    behind: true,
    allowedActions: [{ action: 'dependabot_rebase' }],
    ...over,
  };
}

const none = () => undefined;

describe('rebaseAllPlan', () => {
  test('counts the rows behind their base that offer a rebase', () => {
    const plan = rebaseAllPlan(
      [
        row({ number: 1 }),
        row({
          number: 2,
          forge: 'forgejo',
          allowedActions: [{ action: 'renovate_rebase' }],
        }),
        row({ number: 3, behind: false }),
      ],
      { blockedReason: none },
    );
    expect(plan.eligible.map((e) => [e.item.number, e.bot])).toEqual([
      [1, 'dependabot'],
      [2, 'renovate'],
    ]);
    expect(plan.total).toBe(3);
  });

  test('skips an empty pull request, as the Out of date badge does', () => {
    const plan = rebaseAllPlan([row({ number: 1, empty: true })], {
      blockedReason: none,
    });
    expect(plan.eligible).toEqual([]);
  });

  test('skips a row whose rebase the server blocks', () => {
    const plan = rebaseAllPlan(
      [
        row({
          number: 1,
          allowedActions: [
            {
              action: 'dependabot_rebase',
              blocked: { code: 'x', message: 'no' },
            },
          ],
        }),
      ],
      { blockedReason: none },
    );
    expect(plan.eligible).toEqual([]);
  });

  test('skips a row with no rebase to ask for', () => {
    const plan = rebaseAllPlan([row({ number: 1, allowedActions: [] })], {
      blockedReason: none,
    });
    expect(plan.eligible).toEqual([]);
  });

  test('leaves out a Dependabot row on a forge that blocks commands', () => {
    const plan = rebaseAllPlan(
      [
        row({ number: 1 }),
        row({
          number: 2,
          forge: 'forgejo',
          allowedActions: [{ action: 'renovate_rebase' }],
        }),
      ],
      { blockedReason: (f) => (f === 'github' ? 'GitHub App, no token' : '') },
    );
    expect(plan.eligible.map((e) => e.item.number)).toEqual([2]);
    expect(plan.blockedReasons).toEqual(['GitHub App, no token']);
  });

  test('leaves out a row already asked, and says it once per reason', () => {
    const plan = rebaseAllPlan([row({ number: 1 }), row({ number: 2 })], {
      blockedReason: none,
      requested: (item) => item.number === 1,
    });
    expect(plan.eligible.map((e) => e.item.number)).toEqual([2]);
  });

  test('counts the rows behind apart from the ones it can ask', () => {
    const plan = rebaseAllPlan(
      [
        row({ number: 1 }),
        row({ number: 2 }),
        row({ number: 3, behind: false }),
        row({ number: 4, empty: true }),
      ],
      { blockedReason: none, requested: (item) => item.number === 1 },
    );
    expect(plan.behind).toBe(2);
    expect(plan.eligible).toHaveLength(1);
  });

  test('counts a repeated reason once', () => {
    const plan = rebaseAllPlan([row({ number: 1 }), row({ number: 2 })], {
      blockedReason: () => 'no token',
    });
    expect(plan.blockedReasons).toEqual(['no token']);
  });
});

describe('labels', () => {
  test('the button names how many it will rebase', () => {
    expect(rebaseAllLabel(6)).toBe('Rebase all (6)');
  });

  test('with none, the button reads plain and the summary says why', () => {
    expect(rebaseAllLabel(0)).toBe('Rebase all');
    expect(summaryLine(0, 9)).toBe('Nothing is out of date.');
  });

  test('the summary counts out of date against listed', () => {
    expect(summaryLine(6, 9)).toBe('6 of 9 are out of date.');
    expect(summaryLine(1, 1)).toBe('1 of 1 is out of date.');
  });

  test('progress counts the rows asked so far', () => {
    expect(progressLabel(3, 6)).toBe('Rebasing 3 of 6');
  });
});

describe('showRebaseAll', () => {
  test('hides when nothing listed is out of date', () => {
    const plan = rebaseAllPlan([row({ number: 1, behind: false })], {
      blockedReason: none,
    });
    expect(showRebaseAll(plan, false)).toBe(false);
  });

  test('hides when the only behind rows are empty', () => {
    const plan = rebaseAllPlan([row({ number: 1, empty: true })], {
      blockedReason: none,
    });
    expect(showRebaseAll(plan, false)).toBe(false);
  });

  test('shows when a listed row is out of date, even if none can be asked', () => {
    const plan = rebaseAllPlan([row({ number: 1, allowedActions: [] })], {
      blockedReason: none,
    });
    expect(showRebaseAll(plan, false)).toBe(true);
  });

  test('stays through a run even when no row is behind any more', () => {
    const plan = rebaseAllPlan([row({ number: 1, behind: false })], {
      blockedReason: none,
    });
    expect(showRebaseAll(plan, true)).toBe(true);
  });
});

// The Failing chip on the strip (#3276): every listed row, out of date or not,
// that the Failing CI pill would count.
describe('rebaseAllPlan failing count', () => {
  test('counts failing rows, not ones held for approval', () => {
    const plan = rebaseAllPlan(
      [
        row({ number: 1 }),
        row({
          number: 2,
          allowedActions: [],
        }),
        row({ number: 3, behind: false, ci: 'failure', failingCi: true }),
        row({ number: 4, behind: false, ci: 'failure', failingCi: false }),
        row({ number: 5 }),
      ],
      { blockedReason: none, requested: (item) => item.number === 5 },
    );
    expect(plan.behind).toBe(3);
    expect(plan.eligible.map((e) => e.item.number)).toEqual([1]);
    expect(plan.failing).toBe(1);
  });

  test('reads the raw CI state when the server gives no failingCi', () => {
    const plan = rebaseAllPlan(
      [
        row({ number: 1, ci: 'failure' }),
        row({ number: 2, ci: 'failure', behind: false }),
        row({ number: 3, ci: 'success' }),
      ],
      { blockedReason: none },
    );
    expect(plan.failing).toBe(2);
  });

  test('is zero when nothing fails', () => {
    expect(
      rebaseAllPlan([row({ number: 1 })], { blockedReason: none }).failing,
    ).toBe(0);
  });
});
