/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { swapLabel, tapOutcome } from './wait-chip-swap';

describe('tapOutcome', () => {
  test('a mouse click on a previewed chip runs Update branch', () => {
    expect(tapOutcome({ revealed: true, detail: 1, locked: false })).toBe(
      'run',
    );
  });

  test('a first touch tap only reveals Update branch', () => {
    expect(tapOutcome({ revealed: false, detail: 1, locked: false })).toBe(
      'reveal',
    );
  });

  test('Enter, Space and a screen reader click (detail 0) run it at once', () => {
    expect(tapOutcome({ revealed: false, detail: 0, locked: false })).toBe(
      'run',
    );
  });

  test('a locked button never runs, and says why instead', () => {
    expect(tapOutcome({ revealed: true, detail: 0, locked: true })).toBe(
      'explain',
    );
    expect(tapOutcome({ revealed: false, detail: 1, locked: true })).toBe(
      'explain',
    );
  });
});

describe('swapLabel', () => {
  test('shows the wait until the swap is revealed', () => {
    expect(swapLabel({ revealed: false, inFlight: false })).toBe(
      'Waiting for CI',
    );
    expect(swapLabel({ revealed: true, inFlight: false })).toBe(
      'Update branch',
    );
  });

  test('says Updating branch while in flight, revealed or not', () => {
    expect(swapLabel({ revealed: false, inFlight: true })).toBe(
      'Updating branch…',
    );
    expect(swapLabel({ revealed: true, inFlight: true })).toBe(
      'Updating branch…',
    );
  });
});
