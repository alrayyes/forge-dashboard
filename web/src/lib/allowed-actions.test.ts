/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { type AllowedAction, primaryAction } from './allowed-actions';

// The server marks at most one available action primary and the page only
// renders that. These pin the reading, not the rule.

describe('primaryAction', () => {
  test('returns the entry the server marked primary', () => {
    const allowedActions: AllowedAction[] = [
      { action: 'close' },
      { action: 'merge', primary: true },
      { action: 'auto_merge' },
    ];
    expect(primaryAction({ allowedActions })?.action).toBe('merge');
  });

  test('returns undefined when no entry is primary', () => {
    expect(
      primaryAction({
        allowedActions: [{ action: 'merge' }, { action: 'close' }],
      }),
    ).toBeUndefined();
  });

  test('a missing allowedActions or an empty list means none', () => {
    expect(primaryAction({})).toBeUndefined();
    expect(primaryAction({ allowedActions: [] })).toBeUndefined();
  });

  test('primary false counts as not primary', () => {
    expect(
      primaryAction({ allowedActions: [{ action: 'merge', primary: false }] }),
    ).toBeUndefined();
  });

  test('a server that sent two takes the first, and the page does not choose', () => {
    expect(
      primaryAction({
        allowedActions: [
          { action: 'update_branch', primary: true },
          { action: 'merge', primary: true },
        ],
      })?.action,
    ).toBe('update_branch');
  });
});
