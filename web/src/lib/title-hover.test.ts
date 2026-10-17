/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createTitleHover, isTruncated } from './title-hover';

// The decision and the shared observer are checked here without a browser.
// The page wiring is title-hover-text.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/1695

describe('isTruncated', () => {
  test('is true only when the text is wider than its box', () => {
    expect(isTruncated({ scrollWidth: 400, clientWidth: 300 })).toBe(true);
    expect(isTruncated({ scrollWidth: 300, clientWidth: 300 })).toBe(false);
    expect(isTruncated({ scrollWidth: 200, clientWidth: 300 })).toBe(false);
  });

  test('is false for a box with no layout (hidden, detached)', () => {
    expect(isTruncated({ scrollWidth: 0, clientWidth: 0 })).toBe(false);
  });
});

type Box = {
  scrollWidth: number;
  clientWidth: number;
  isConnected: boolean;
  attrs: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

function box(scrollWidth: number, clientWidth: number): Box {
  const attrs = new Map<string, string>();
  return {
    scrollWidth,
    clientWidth,
    isConnected: true,
    attrs,
    setAttribute: (n, v) => void attrs.set(n, v),
    removeAttribute: (n) => void attrs.delete(n),
  };
}

function fakeObserver() {
  const observed = new Set<unknown>();
  let callback: (entries: { target: unknown }[]) => void = () => {};
  const instances: unknown[] = [];
  let disconnected = false;
  class FakeObserver {
    constructor(cb: (entries: { target: unknown }[]) => void) {
      callback = cb;
      instances.push(this);
    }
    observe(t: unknown) {
      observed.add(t);
    }
    unobserve(t: unknown) {
      observed.delete(t);
    }
    disconnect() {
      disconnected = true;
      observed.clear();
    }
  }
  return {
    ctor: FakeObserver as unknown as typeof ResizeObserver,
    observed,
    instances,
    fire: (...targets: unknown[]) =>
      callback(targets.map((target) => ({ target }))),
    wasDisconnected: () => disconnected,
  };
}

describe('createTitleHover', () => {
  test('sets the full title as an attribute only while truncated', () => {
    const ro = fakeObserver();
    const hover = createTitleHover(ro.ctor);
    const el = box(500, 300);
    hover.track(el as unknown as HTMLElement, 'A very long <b>title</b>');
    ro.fire(el);
    expect(el.attrs.get('title')).toBe('A very long <b>title</b>');
    el.clientWidth = 600;
    ro.fire(el);
    expect(el.attrs.has('title')).toBe(false);
    el.clientWidth = 200;
    ro.fire(el);
    expect(el.attrs.get('title')).toBe('A very long <b>title</b>');
  });

  test('uses one observer for every row', () => {
    const ro = fakeObserver();
    const hover = createTitleHover(ro.ctor);
    for (let i = 0; i < 200; i++)
      hover.track(box(10, 10) as unknown as HTMLElement, `t${i}`);
    expect(ro.instances).toHaveLength(1);
    expect(ro.observed.size).toBe(200);
  });

  test('prune stops watching rows that left the page', () => {
    const ro = fakeObserver();
    const hover = createTitleHover(ro.ctor);
    const gone = box(500, 300);
    const kept = box(500, 300);
    hover.track(gone as unknown as HTMLElement, 'gone');
    hover.track(kept as unknown as HTMLElement, 'kept');
    gone.isConnected = false;
    hover.prune();
    expect(ro.observed.has(gone)).toBe(false);
    expect(ro.observed.has(kept)).toBe(true);
  });

  test('destroy disconnects the observer', () => {
    const ro = fakeObserver();
    const hover = createTitleHover(ro.ctor);
    hover.track(box(1, 1) as unknown as HTMLElement, 't');
    hover.destroy();
    expect(ro.wasDisconnected()).toBe(true);
  });
});

describe('recheck', () => {
  test('measures every tracked title again', () => {
    const ro = fakeObserver();
    const hover = createTitleHover(ro.ctor);
    const el = box(100, 100);
    hover.track(el as unknown as HTMLElement, 'T');
    el.scrollWidth = 150;
    hover.recheck();
    expect(el.attrs.get('title')).toBe('T');
  });
});
