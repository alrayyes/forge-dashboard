/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { anyRowHoldsTheBoard, holdsTheBoard } from './row-action-in-flight';

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

describe('anyRowHoldsTheBoard', () => {
  test('holds the board when one row in one of the maps is mid-way', () => {
    expect(
      anyRowHoldsTheBoard([
        {},
        { 'o/r#1': { phase: 'idle' } },
        { 'o/r#2': { phase: 'requesting' } },
      ]),
    ).toBe(true);
  });

  test('lets snapshots land when every row is over, cancelled or restored', () => {
    expect(
      anyRowHoldsTheBoard([
        { 'o/r#1': { phase: 'cancelled' } },
        { 'o/r#2': { phase: 'queued', queued: { restored: true } } },
        { 'o/r#3': { phase: 'rebasing' } },
      ]),
    ).toBe(false);
  });

  test('lets snapshots land when there are no rows', () => {
    expect(anyRowHoldsTheBoard([])).toBe(false);
    expect(anyRowHoldsTheBoard([{}, {}])).toBe(false);
  });
});
