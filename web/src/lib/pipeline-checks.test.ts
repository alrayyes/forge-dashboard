/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  blockingFirst,
  CHECK_STATE_LABELS,
  type Check,
  checkRunKey,
  formatCheckDuration,
  groupChecks,
  isBlocking,
  runPageUrl,
} from './pipeline-checks';

const check = (over: Partial<Check>): Check => ({
  name: 'build',
  state: 'success',
  url: '',
  ...over,
});

describe('formatCheckDuration', () => {
  test('seconds alone under a minute', () => {
    expect(formatCheckDuration(42)).toBe('42s');
  });

  test('minutes and seconds under an hour', () => {
    expect(formatCheckDuration(125)).toBe('2m 5s');
  });

  test('hours and minutes from an hour up', () => {
    expect(formatCheckDuration(3700)).toBe('1h 1m');
  });
});

describe('CHECK_STATE_LABELS', () => {
  test('names every state the checks endpoint can answer', () => {
    expect(Object.keys(CHECK_STATE_LABELS).sort()).toEqual([
      'awaiting_approval',
      'cancelled',
      'failure',
      'queued',
      'running',
      'skipped',
      'success',
      'timed_out',
    ]);
  });
});

describe('isBlocking', () => {
  test('a required check that failed, timed out or is held blocks', () => {
    for (const state of ['failure', 'timed_out', 'awaiting_approval']) {
      expect(isBlocking(check({ required: true, state }))).toBe(true);
    }
  });

  test('an advisory, unknown or healthy check does not', () => {
    expect(isBlocking(check({ required: false, state: 'failure' }))).toBe(
      false,
    );
    expect(isBlocking(check({ state: 'failure' }))).toBe(false);
    expect(isBlocking(check({ required: true, state: 'success' }))).toBe(false);
  });
});

describe('blockingFirst', () => {
  test('moves blocking checks up and keeps the forge order otherwise', () => {
    const a = check({ name: 'a' });
    const b = check({ name: 'b', required: true, state: 'failure' });
    const c = check({ name: 'c' });
    const d = check({ name: 'd', required: true, state: 'timed_out' });

    expect(blockingFirst([a, b, c, d]).map((x) => x.name)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });
});

describe('groupChecks', () => {
  test('one flat list when the forge said nothing about required', () => {
    const list = [check({ name: 'a' }), check({ name: 'b' })];

    expect(groupChecks(list)).toEqual([{ id: '', title: '', checks: list }]);
  });

  test('Required, Advisory and Status unknown, each only when it has checks', () => {
    const req = check({ name: 'r', required: true });
    const adv = check({ name: 'a', required: false });
    const unk = check({ name: 'u' });

    expect(groupChecks([unk, adv, req])).toEqual([
      { id: 'pipeline-group-required', title: 'Required', checks: [req] },
      { id: 'pipeline-group-advisory', title: 'Advisory', checks: [adv] },
      {
        id: 'pipeline-group-unknown',
        title: 'Status unknown',
        checks: [unk],
      },
    ]);
    expect(groupChecks([req]).map((g) => g.title)).toEqual(['Required']);
  });

  test('no checks, no groups', () => {
    expect(groupChecks([])).toEqual([]);
  });
});

describe('checkRunKey', () => {
  test('changes with the attempt and with the duration', () => {
    const a = check({ url: 'u', runAttempt: 1, durationSeconds: 5 });

    expect(checkRunKey({ ...a, runAttempt: 2 })).not.toBe(checkRunKey(a));
    expect(checkRunKey({ ...a, durationSeconds: 6 })).not.toBe(checkRunKey(a));
  });

  test('keeps the key when a later excerpt arrives and the forge numbers the run', () => {
    const a = check({ url: 'u', runAttempt: 1, excerpt: 'one' });

    expect(checkRunKey({ ...a, excerpt: 'two' })).toBe(checkRunKey(a));
  });

  test('falls back to the excerpt when the forge gives neither attempt nor duration', () => {
    const a = check({ url: 'u', excerpt: 'first failure' });

    expect(checkRunKey({ ...a, excerpt: 'second failure' })).not.toBe(
      checkRunKey(a),
    );
    expect(checkRunKey({ ...a })).toBe(checkRunKey(a));
  });
});

describe('runPageUrl', () => {
  test('trims a GitHub job page to its run page', () => {
    const checks = [
      check({ url: 'https://github.com/o/r/actions/runs/123/job/456' }),
    ];
    expect(runPageUrl(checks)).toBe('https://github.com/o/r/actions/runs/123');
  });

  test('trims a Forgejo job page to its run page', () => {
    const checks = [
      check({ url: 'https://f.example/o/r/actions/runs/7/jobs/2' }),
    ];
    expect(runPageUrl(checks)).toBe('https://f.example/o/r/actions/runs/7');
  });

  test('takes the newest run when jobs span several', () => {
    const checks = [
      check({ url: 'https://f.example/o/r/actions/runs/7/jobs/2' }),
      check({ url: 'https://f.example/o/r/actions/runs/9/jobs/0' }),
    ];
    expect(runPageUrl(checks)).toBe('https://f.example/o/r/actions/runs/9');
  });

  test('is undefined for a third-party status or no checks', () => {
    const third = [check({ url: 'https://ci.example/build/1' })];
    expect(runPageUrl(third)).toBeUndefined();
    expect(runPageUrl([check({ url: '' })])).toBeUndefined();
    expect(runPageUrl([])).toBeUndefined();
  });
});
