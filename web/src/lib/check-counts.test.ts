/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { checkSegments, pillName, pillWord } from './check-counts';

describe('checkSegments', () => {
  test('draws passed, running, waiting, failed in that order', () => {
    expect(
      checkSegments({ passed: 5, running: 2, waiting: 3, failed: 1 }),
    ).toEqual([
      { kind: 'passed', n: 5 },
      { kind: 'running', n: 2 },
      { kind: 'waiting', n: 3 },
      { kind: 'failed', n: 1 },
    ]);
  });

  test('never draws a zero', () => {
    expect(
      checkSegments({ passed: 0, running: 1, waiting: 8, failed: 0 }),
    ).toEqual([
      { kind: 'running', n: 1 },
      { kind: 'waiting', n: 8 },
    ]);
  });

  test('draws nothing without counts or with all zeros', () => {
    expect(checkSegments(undefined)).toEqual([]);
    expect(
      checkSegments({ passed: 0, running: 0, waiting: 0, failed: 0 }),
    ).toEqual([]);
  });
});

describe('checkSegments with skipped', () => {
  test('draws skipped beside passed, which stays whole', () => {
    expect(
      checkSegments({
        passed: 8,
        skipped: 2,
        running: 1,
        waiting: 0,
        failed: 0,
      }),
    ).toEqual([
      { kind: 'passed', n: 8 },
      { kind: 'skipped', n: 2 },
      { kind: 'running', n: 1 },
    ]);
  });

  test('drops the passed segment when every pass was skipped', () => {
    expect(
      checkSegments({
        passed: 3,
        skipped: 3,
        running: 0,
        waiting: 0,
        failed: 1,
      }),
    ).toEqual([
      { kind: 'skipped', n: 3 },
      { kind: 'failed', n: 1 },
    ]);
  });

  test('draws no skipped segment for none, or an older answer without it', () => {
    const base = { passed: 5, running: 0, waiting: 0, failed: 0 };

    expect(checkSegments({ ...base, skipped: 0 })).toEqual([
      { kind: 'passed', n: 5 },
    ]);
    expect(checkSegments(base)).toEqual([{ kind: 'passed', n: 5 }]);
  });

  test('names the skipped count in words', () => {
    expect(
      pillName(
        'Passed',
        checkSegments({
          passed: 8,
          skipped: 2,
          running: 0,
          waiting: 0,
          failed: 0,
        }),
      ),
    ).toBe('Passed 8 2: 8 passed, 2 of them skipped');
  });
});

describe('skipped held to passed', () => {
  test('never draws more skipped than passed', () => {
    expect(
      checkSegments({
        passed: 2,
        skipped: 5,
        running: 0,
        waiting: 0,
        failed: 1,
      }),
    ).toEqual([
      { kind: 'skipped', n: 2 },
      { kind: 'failed', n: 1 },
    ]);
  });

  test('draws no skipped when nothing passed', () => {
    expect(
      checkSegments({
        passed: 0,
        skipped: 4,
        running: 1,
        waiting: 0,
        failed: 0,
      }),
    ).toEqual([{ kind: 'running', n: 1 }]);
  });
});

describe('pillWord', () => {
  const only = [{ kind: 'skipped' as const, n: 3 }];

  test('says Skipped for a pass that was only skipped checks', () => {
    expect(pillWord('Passed', only)).toBe('Skipped');
  });

  test('keeps the word beside other segments or on another state', () => {
    expect(
      pillWord('Passed', [
        { kind: 'passed', n: 8 },
        { kind: 'skipped', n: 2 },
      ]),
    ).toBe('Passed');
    expect(pillWord('Failed', only)).toBe('Failed');
    expect(pillWord('Running', only)).toBe('Running');
  });
});

describe('pillName', () => {
  test('starts with the visible text and lists each count in words', () => {
    const name = pillName(
      'Running',
      checkSegments({ passed: 5, running: 2, waiting: 3, failed: 0 }),
    );

    expect(name).toBe('Running 5 2 3: 5 passed, 2 running, 3 waiting');
  });

  test('contains the pill text whole, spaces and all', () => {
    const name = pillName(
      'Running',
      checkSegments({ passed: 0, running: 1, waiting: 8, failed: 0 }),
    );

    expect(name).toContain('Running 1 8');
  });

  test('says the word of a passed pipeline', () => {
    expect(
      pillName(
        'Passed',
        checkSegments({ passed: 12, running: 0, waiting: 0, failed: 0 }),
      ),
    ).toBe('Passed 12: 12 passed');
  });

  test('says the word of a failed pipeline that still has checks going', () => {
    expect(
      pillName(
        'Failed',
        checkSegments({ passed: 8, running: 1, waiting: 2, failed: 3 }),
      ),
    ).toBe('Failed 8 1 2 3: 8 passed, 1 running, 2 waiting, 3 failed');
  });
});
