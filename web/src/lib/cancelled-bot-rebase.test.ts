/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { type CancelEntry, settleCancelled } from './cancelled-bot-rebase';

describe('settleCancelled', () => {
  test('keeps a cancel the forge took while the snapshot still lists it', () => {
    const states: Record<string, CancelEntry> = { a: { phase: 'cancelled' } };

    settleCancelled(states, (key) => key === 'a');

    expect(states.a).toEqual({ phase: 'cancelled' });
  });

  test('forgets it once a snapshot no longer lists the cancel', () => {
    const states: Record<string, CancelEntry> = { a: { phase: 'cancelled' } };

    settleCancelled(states, () => false);

    expect(states.a).toBeUndefined();
  });

  test('leaves a cancel that is still posting or locked alone', () => {
    const states: Record<string, CancelEntry> = {
      a: { phase: 'requesting' },
      b: { phase: 'locked' },
    };

    settleCancelled(states, () => false);

    expect(Object.keys(states)).toEqual(['a', 'b']);
  });
});
