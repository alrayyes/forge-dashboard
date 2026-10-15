/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  comesBack,
  hideFailedMessage,
  hidMessage,
  nameOf,
  restoredMessage,
  restoreFailedMessage,
} from './hidden-pull-requests';

// The wording around hiding a pull request lives in one module, so it is
// checked here without a browser. The page wiring is hide-pull-request.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/841

const NOW = Date.parse('2026-10-12T12:00:00Z');
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

describe('when a hidden pull request comes back', () => {
  test('one hidden until restored says so', () => {
    expect(comesBack(undefined, NOW)).toBe('Hidden until you restore it');
  });

  test('a timed hide counts the days left, rounded up', () => {
    expect(comesBack(inDays(5.2), NOW)).toBe('Back in 6 days');
  });

  test('exactly 7 days is 7 days', () => {
    expect(comesBack(inDays(7), NOW)).toBe('Back in 7 days');
  });

  test('under a day left is 1 day, singular', () => {
    expect(comesBack(inDays(0.2), NOW)).toBe('Back in 1 day');
  });

  test('a hide whose time has passed says it is about to come back', () => {
    expect(comesBack(inDays(-1), NOW)).toBe('Back any moment');
  });

  test('a time that does not parse never says "Back in NaN days"', () => {
    expect(comesBack('not a date', NOW)).toBe('Back any moment');
  });
});

describe('naming a pull request', () => {
  const pr = { number: 123, title: 'Fix the thing' };

  test('the number and the title, so equal titles can be told apart', () => {
    expect(nameOf(pr)).toBe('PR #123 ‘Fix the thing’');
  });

  test('the messages read the way the ticket words them', () => {
    expect([hidMessage(pr), restoredMessage(pr)]).toEqual([
      'Hid PR #123 ‘Fix the thing’.',
      'Restored PR #123 ‘Fix the thing’.',
    ]);
  });

  test('a failure says what could not be done and to try again', () => {
    expect([hideFailedMessage(pr), restoreFailedMessage(pr)]).toEqual([
      'Couldn’t hide PR #123 ‘Fix the thing’. Try again.',
      'Couldn’t restore PR #123 ‘Fix the thing’. Try again.',
    ]);
  });
});
