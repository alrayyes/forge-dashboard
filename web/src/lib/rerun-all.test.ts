/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { AllowedAction } from './allowed-actions';
import {
  type Probe,
  QUEUED_REASON,
  rerunAllLabel,
  rerunAllPlan,
  rerunProgressLabel,
  showRerunAll,
} from './rerun-all';

// "Rerun failed checks" on the Pull requests and Bots pages sorts the listed
// failing rows before it sends anything: the ones a rerun can restart, the
// ones it can't with a reason, and the ones the server has yet to answer for.

type Row = {
  forge: string;
  repo: string;
  number: number;
  title: string;
  ci: string;
  allowedActions?: AllowedAction[];
};

function row(over: Partial<Row> & { number: number }): Row {
  return {
    forge: 'github',
    repo: 'acme/api',
    title: 'fix x',
    ci: 'failure',
    allowedActions: [{ action: 'rerun_checks' }],
    ...over,
  };
}

const yes: Probe = { rerunnable: true };

function plan(
  rows: Row[],
  over: {
    probe?: (r: Row) => Probe | undefined;
    lock?: (forge: string) => string | undefined;
    queued?: (r: Row) => boolean;
  } = {},
) {
  return rerunAllPlan(rows, {
    probe: over.probe ?? (() => yes),
    lockReason: over.lock ?? (() => undefined),
    queued: over.queued,
  });
}

describe('rerunAllPlan', () => {
  test('a failing row the server says has a job to rerun will rerun', () => {
    const p = plan([row({ number: 1 }), row({ number: 2 })]);
    expect(p.eligible.map((r) => r.number)).toEqual([1, 2]);
    expect(p.failing).toBe(2);
    expect(p.total).toBe(2);
  });

  test('a row that is not failing is not counted at all', () => {
    const p = plan([row({ number: 1, ci: 'success', allowedActions: [] })]);
    expect(p.failing).toBe(0);
    expect(p.eligible).toEqual([]);
    expect(p.leftOut).toEqual([]);
  });

  test('a failing row on an external CI is left out with its reason', () => {
    const p = plan([row({ number: 1 })], {
      probe: () => ({
        rerunnable: false,
        reason: 'no failed GitHub Actions job to rerun on this pull request',
      }),
    });
    expect(p.eligible).toEqual([]);
    expect(p.leftOut.map((l) => l.reason)).toEqual([
      "Failing on an external CI, or no job ran. It can't be rerun from here.",
    ]);
  });

  test('another reason the forge gave is shown as a sentence', () => {
    const p = plan([row({ number: 1 })], {
      probe: () => ({
        rerunnable: false,
        reason: 'Rerunning checks needs Forgejo 17 or later',
      }),
    });
    expect(p.leftOut[0].reason).toBe(
      'Rerunning checks needs Forgejo 17 or later.',
    );
  });

  test('a forge that is locked leaves its rows out with the lock reason, unasked', () => {
    let asked = 0;
    const p = plan([row({ number: 1, forge: 'forgejo' })], {
      lock: () => 'Rerunning checks needs Forgejo 17 or later.',
      probe: () => {
        asked++;
        return yes;
      },
    });
    expect(p.leftOut[0].reason).toBe(
      'Rerunning checks needs Forgejo 17 or later.',
    );
    expect(asked).toBe(0);
  });

  test('a rerun already queued is left out', () => {
    const p = plan([row({ number: 1 }), row({ number: 2 })], {
      queued: (r) => r.number === 1,
    });
    expect(p.leftOut).toEqual([
      { item: expect.objectContaining({ number: 1 }), reason: QUEUED_REASON },
    ]);
    expect(p.eligible.map((r) => r.number)).toEqual([2]);
  });

  test('a row that is not offered the rerun says so', () => {
    const p = plan([row({ number: 1, allowedActions: [] })]);
    expect(p.leftOut[0].reason).toBe(
      'No rerun is offered for this pull request.',
    );
  });

  test('a row with no answer yet is checking, neither run nor left out', () => {
    const p = plan([row({ number: 1 }), row({ number: 2 })], {
      probe: (r) => (r.number === 1 ? undefined : yes),
    });
    expect(p.checking.map((r) => r.number)).toEqual([1]);
    expect(p.eligible.map((r) => r.number)).toEqual([2]);
    expect(p.leftOut).toEqual([]);
  });

  test('a probe that failed leaves the row for the forge to decide', () => {
    const p = plan([row({ number: 1 })], {
      probe: () => ({ unknown: true }),
    });
    expect(p.eligible.map((r) => r.number)).toEqual([1]);
  });
});

describe('labels', () => {
  test('the button carries the count that can run', () => {
    expect(rerunAllLabel(4)).toBe('Rerun failed checks (4)');
    expect(rerunAllLabel(0)).toBe('Rerun failed checks');
  });

  test('progress reads in words', () => {
    expect(rerunProgressLabel(2, 4)).toBe('Rerunning 2 of 4');
  });

  test('the control shows only while a failing row can still run or a run is going', () => {
    const noFailing = plan([row({ number: 1, ci: 'success' })]);
    const some = plan([row({ number: 1 })]);
    expect(showRerunAll(noFailing, false)).toBe(false);
    expect(showRerunAll(noFailing, true)).toBe(true);
    expect(showRerunAll(some, false)).toBe(true);
  });

  test('it is gone once every failing row is left out, whatever the reason', () => {
    const no: Probe = { rerunnable: false, reason: 'no failed job' };
    const queued = plan([row({ number: 1 }), row({ number: 2 })], {
      queued: () => true,
    });
    const answered = plan([row({ number: 1 })], { probe: () => no });
    const locked = plan([row({ number: 1 })], { lock: () => 'rate limited' });
    const notOffered = plan([row({ number: 1, allowedActions: [] })]);
    for (const p of [queued, answered, locked, notOffered])
      expect(showRerunAll(p, false)).toBe(false);
  });

  test('it stays while a run or the dialog is open, so progress and focus survive', () => {
    const answered = plan([row({ number: 1 })], {
      probe: () => ({ rerunnable: false, reason: 'no failed job' }),
    });
    expect(showRerunAll(answered, true)).toBe(true);
  });

  test('it is never hidden before the server has answered', () => {
    const waiting = plan([row({ number: 1 }), row({ number: 2 })], {
      probe: () => undefined,
    });
    expect(showRerunAll(waiting, false)).toBe(true);
  });

  test('it comes back when one row can run again', () => {
    const no: Probe = { rerunnable: false, reason: 'no failed job' };
    const gone = plan([row({ number: 1 })], { probe: () => no });
    const back = plan([row({ number: 1 })], { probe: () => yes });
    expect(showRerunAll(gone, false)).toBe(false);
    expect(showRerunAll(back, false)).toBe(true);
  });

  test('one row that can run is enough, beside rows that cannot', () => {
    const p = plan([row({ number: 1 }), row({ number: 2 })], {
      queued: (r) => r.number === 1,
    });
    expect(showRerunAll(p, false)).toBe(true);
  });
});
