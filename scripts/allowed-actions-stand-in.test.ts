/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  allowedActionsFixture,
  allowedActionsFor,
} from '../tests/allowed-actions-stand-in';

// The Playwright stand-in answers from the table the Go rules generate, so
// `primary` reaches a mocked pull request exactly as the server sent it.

describe('allowed-actions stand-in', () => {
  test('a ready pull request gets Merge as its primary action', () => {
    const entries = allowedActionsFor({
      forge: 'github',
      ci: 'success',
      mergeStatus: 'mergeable',
    });
    expect(entries.filter((e) => e.primary).map((e) => e.action)).toEqual([
      'merge',
    ]);
  });

  test('an empty pull request gets Close as its primary action', () => {
    const entries = allowedActionsFor({
      forge: 'github',
      empty: true,
      ci: 'success',
      mergeStatus: 'mergeable',
    });
    expect(entries.filter((e) => e.primary).map((e) => e.action)).toEqual([
      'close',
    ]);
  });

  test('a blocked pull request has no primary action', () => {
    const entries = allowedActionsFor({
      forge: 'github',
      ci: 'success',
      mergeStatus: 'blocked',
    });
    expect(entries.some((e) => e.primary)).toBe(false);
  });

  test('every answer in the table has at most one primary, never a blocked one', () => {
    for (const output of allowedActionsFixture.outputs) {
      const primaries = output.allowedActions.filter((e) => e.primary);
      expect(primaries.length).toBeLessThanOrEqual(1);
      for (const e of primaries) expect(e.blocked).toBeUndefined();
    }
  });
});
