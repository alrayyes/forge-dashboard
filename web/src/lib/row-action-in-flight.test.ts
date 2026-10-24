/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { holdsTheBoard } from './row-action-in-flight';

describe('holdsTheBoard', () => {
  test('holds the board while a click of this page is mid-way', () => {
    for (const phase of [
      'confirming',
      'merging',
      'closing',
      'queued',
      'requesting',
      'enabling',
    ])
      expect(holdsTheBoard({ phase })).toBe(true);
  });

  test('lets snapshots land in place once the action is over or not a click', () => {
    for (const phase of ['idle', 'locked', 'merged', 'closed', 'rebasing'])
      expect(holdsTheBoard({ phase })).toBe(false);
  });

  test('does not hold the board for a cancel the forge already took', () => {
    expect(holdsTheBoard({ phase: 'cancelled' })).toBe(false);
  });

  test('does not hold the board for a request only restored from a snapshot', () => {
    expect(holdsTheBoard({ phase: 'queued', queued: { restored: true } })).toBe(
      false,
    );
  });
});
