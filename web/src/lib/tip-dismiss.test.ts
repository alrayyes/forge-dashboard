/// <reference types="bun" />
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

// Escape closes an open tooltip until the pointer and focus have both left its
// control (WCAG 1.4.13). One helper serves the repo controls and the wait
// chip. `bun test` has no DOM, so hosts and the document are small fakes. The
// CSS side (the hoverable bridge) is checked in
// settings-repositories-one-line.spec.ts and wait-chip.spec.ts.

type Handler = (event?: unknown) => void;

class FakeHost {
  attrs = new Map<string, string>();
  listeners = new Map<string, Handler[]>();
  hovered = false;
  focused = false;
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
  matches(selector: string) {
    const wants = selector.split(',').map((s) => s.trim());
    return (
      (wants.includes(':hover') && this.hovered) ||
      (wants.includes(':focus-within') && this.focused)
    );
  }
  addEventListener(type: string, fn: Handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

const hosts: FakeHost[] = [];
const keydown: Handler[] = [];
const g = globalThis as unknown as { document?: unknown };
const saved = g.document;

// The module binds one document listener the first time a host mounts, so the
// fake document is installed once, before it is imported.
g.document = {
  addEventListener: (type: string, fn: Handler) => {
    if (type === 'keydown') keydown.push(fn);
  },
  removeEventListener: () => {},
  querySelectorAll: (selector: string) =>
    hosts.filter(
      (h) =>
        selector.includes('data-tip-host') &&
        h.hasAttribute('data-tip-host') &&
        h.matches(':hover, :focus-within'),
    ),
};
const { tipDismiss } = await import('./tip-dismiss');

beforeEach(() => {
  hosts.length = 0;
});

afterAll(() => {
  g.document = saved;
});

const mount = () => {
  const host = new FakeHost();
  hosts.push(host);
  tipDismiss(host as unknown as HTMLElement);
  return host;
};
const press = (key: string) => {
  for (const fn of keydown) fn({ key });
};
const microtasks = () => new Promise((r) => queueMicrotask(() => r(null)));

describe('tipDismiss', () => {
  test('Escape dismisses the tip of a hovered or focused host only', () => {
    const idle = mount();
    const hovered = mount();
    hovered.hovered = true;
    const focused = mount();
    focused.focused = true;
    press('Escape');
    expect(idle.hasAttribute('data-tip-dismissed')).toBe(false);
    expect(hovered.hasAttribute('data-tip-dismissed')).toBe(true);
    expect(focused.hasAttribute('data-tip-dismissed')).toBe(true);
  });

  test('other keys leave the tip alone', () => {
    const host = mount();
    host.hovered = true;
    press('Enter');
    expect(host.hasAttribute('data-tip-dismissed')).toBe(false);
  });

  test('it stays dismissed until the pointer and focus have both left', async () => {
    const host = mount();
    host.hovered = true;
    host.focused = true;
    press('Escape');
    host.hovered = false;
    host.fire('pointerleave');
    expect(host.hasAttribute('data-tip-dismissed')).toBe(true);
    host.focused = false;
    host.fire('focusout');
    await microtasks();
    expect(host.hasAttribute('data-tip-dismissed')).toBe(false);
  });

  test('many hosts share one document listener', () => {
    mount();
    mount();
    mount();
    expect(keydown.length).toBe(1);
  });
});
