/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  blockingFirst,
  CHECK_STATE_LABELS,
  type Check,
  checkDurationSeconds,
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
  test('names every state a check can be in', () => {
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

describe('checkDurationSeconds', () => {
  const at = (start: string, end?: string) =>
    check({ startedAt: start, completedAt: end });

  test('works the duration out from the two timestamps', () => {
    expect(
      checkDurationSeconds(at('2026-10-03T10:00:00Z', '2026-10-03T10:01:30Z')),
    ).toBe(90);
  });

  test('a job that ends the moment it starts ran for zero seconds', () => {
    expect(
      checkDurationSeconds(at('2026-10-03T10:00:00Z', '2026-10-03T10:00:00Z')),
    ).toBe(0);
  });

  test('counts the same span whatever the offset the dates carry', () => {
    expect(
      checkDurationSeconds(
        at('2026-10-03T12:00:00+02:00', '2026-10-03T10:01:30Z'),
      ),
    ).toBe(90);
  });

  test('says nothing while the job has no end', () => {
    expect(checkDurationSeconds(at('2026-10-03T10:00:00Z'))).toBeUndefined();
    expect(checkDurationSeconds(check({}))).toBeUndefined();
  });

  test('says nothing for an end before the start or a bad date', () => {
    expect(
      checkDurationSeconds(at('2026-10-03T10:01:00Z', '2026-10-03T10:00:00Z')),
    ).toBeUndefined();
    expect(checkDurationSeconds(at('nope', 'nah'))).toBeUndefined();
  });
});

describe('checkRunKey', () => {
  test('changes with the attempt and with the end time', () => {
    const a = check({
      url: 'u',
      runAttempt: 1,
      startedAt: '2026-10-03T10:00:00Z',
      completedAt: '2026-10-03T10:00:05Z',
    });

    expect(checkRunKey({ ...a, runAttempt: 2 })).not.toBe(checkRunKey(a));
    expect(checkRunKey({ ...a, completedAt: '2026-10-03T10:00:06Z' })).not.toBe(
      checkRunKey(a),
    );
  });

  test('a new end time on the same attempt is a new run', () => {
    const a = check({
      url: 'u',
      runAttempt: 1,
      completedAt: '2026-10-03T10:00:05Z',
    });

    expect(checkRunKey({ ...a, completedAt: '2026-10-03T10:00:09Z' })).not.toBe(
      checkRunKey(a),
    );
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
