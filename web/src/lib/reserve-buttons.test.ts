/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { reserveButtons } from './reserve-buttons';

// The measuring is checked here with fake boxes; the real layout is
// tests/settings-field-buttons-inside.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/4863

type Rect = { left: number; right: number; width: number };
const rect = (left: number, right: number): Rect => ({
  left,
  right,
  width: right - left,
});

function fakeNode(wrapper: Rect, buttons: Rect[]) {
  const props = new Map<string, string>();
  const node = {
    getBoundingClientRect: () => wrapper,
    querySelectorAll: () =>
      buttons.map((b) => ({ getBoundingClientRect: () => b })),
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
    },
  };
  return { node: node as unknown as HTMLElement, props };
}

let callback: () => void;
let observed: unknown[];
let disconnected: number;
const realRO = globalThis.ResizeObserver;

beforeEach(() => {
  observed = [];
  disconnected = 0;
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) {
      callback = cb;
    }
    observe(el: unknown) {
      observed.push(el);
    }
    disconnect() {
      disconnected++;
    }
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = realRO;
});

describe('reserveButtons', () => {
  test('reserves the wrapper edge to the first button plus a gap', () => {
    const { node, props } = fakeNode(rect(0, 300), [
      rect(200, 250),
      rect(250, 295),
    ]);
    reserveButtons(node);
    expect(props.get('--reserved')).toBe('108px');
  });

  test('does nothing while the wrapper is hidden', () => {
    const { node, props } = fakeNode(rect(0, 0), [rect(0, 0)]);
    reserveButtons(node);
    expect(props.size).toBe(0);
  });

  test('does nothing when there are no buttons', () => {
    const { node, props } = fakeNode(rect(0, 300), []);
    reserveButtons(node);
    expect(props.size).toBe(0);
  });

  test('measures again when the observer fires', () => {
    const buttons = [rect(200, 295)];
    const { node, props } = fakeNode(rect(0, 300), buttons);
    reserveButtons(node);
    expect(props.get('--reserved')).toBe('108px');
    buttons[0] = rect(150, 295);
    callback();
    expect(props.get('--reserved')).toBe('158px');
  });

  test('observes the wrapper and each button, and disconnects on destroy', () => {
    const { node } = fakeNode(rect(0, 300), [rect(200, 250), rect(250, 295)]);
    const action = reserveButtons(node);
    expect(observed).toHaveLength(3);
    action.destroy();
    expect(disconnected).toBe(1);
  });
});
