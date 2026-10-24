/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { LockRedraw } from './lock-redraw';

describe('LockRedraw', () => {
  test('a control that drew under a key asks for no redraw until the key changes', () => {
    const gate = new LockRedraw();
    gate.drawn('a');

    expect(gate.changed('a')).toBe(false);
    expect(gate.changed('b')).toBe(true);
    expect(gate.changed('b')).toBe(false);
  });

  test('a dialog whose control never draws asks for no redraw per snapshot', () => {
    const gate = new LockRedraw();

    expect(gate.changed('a')).toBe(false);
    expect(gate.changed('a')).toBe(false);
    expect(gate.changed('a')).toBe(false);
  });

  test('a change after a key was first seen still redraws, once', () => {
    const gate = new LockRedraw();
    gate.changed('a');

    expect(gate.changed('b')).toBe(true);
    expect(gate.changed('b')).toBe(false);
  });

  test('reset forgets the last key, for the next dialog', () => {
    const gate = new LockRedraw();
    gate.drawn('a');
    gate.reset();

    expect(gate.changed('b')).toBe(false);
    expect(gate.changed('c')).toBe(true);
  });
});
