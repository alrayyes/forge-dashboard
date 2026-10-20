/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { checkSegments, runningPillName } from './check-counts';

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

describe('runningPillName', () => {
  test('starts with the visible text and lists each count in words', () => {
    const name = runningPillName(
      checkSegments({ passed: 5, running: 2, waiting: 3, failed: 0 }),
    );

    expect(name).toBe('Running 5 2 3: 5 passed, 2 running, 3 waiting');
  });

  test('contains the pill text whole, spaces and all', () => {
    const name = runningPillName(
      checkSegments({ passed: 0, running: 1, waiting: 8, failed: 0 }),
    );

    expect(name).toContain('Running 1 8');
  });
});
