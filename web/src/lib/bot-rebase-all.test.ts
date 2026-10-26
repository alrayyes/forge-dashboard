/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { AllowedAction } from './allowed-actions';
import {
  progressLabel,
  rebaseAllLabel,
  rebaseAllPlan,
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
