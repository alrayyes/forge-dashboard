/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  createWarmer,
  intentOn,
  noteKey,
  PREFETCH_DELAY_MS,
  PREFETCH_GRACE_MS,
  PREFETCH_TTL_MS,
} from './prefetch';

// A clock the test moves by hand, so no timer really waits.
function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    set(fn: () => void, ms: number) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear(id: unknown) {
      timers.delete(id as number);
    },
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

function setup(
  opts: {
    delayMs?: number;
    graceMs?: number;
    ttlMs?: number;
    exclusive?: boolean;
    enabled?: () => boolean;
    holds?: boolean;
  } = {},
) {
  const c = clock();
  const started: string[] = [];
  const released: string[] = [];
  const { holds = true, ...rest } = opts;
  const warmer = createWarmer({
    delayMs: 100,
    graceMs: 1000,
    ttlMs: 5000,
    ...rest,
    set: c.set,
    clear: c.clear,
    now: c.now,
    start: (key) => {
      started.push(key);
      return holds ? () => released.push(key) : undefined;
    },
  });
  return { c, warmer, started, released };
}

describe('createWarmer', () => {
  test('nothing starts for a pointer that only passes over (#4192)', () => {
    const { c, warmer, started } = setup();
    warmer.enter('a');
    c.advance(99);
    warmer.leave('a');
    c.advance(5000);
    expect(started).toEqual([]);
  });

  test('a hover that stays starts the read once', () => {
    const { c, warmer, started } = setup();
    warmer.enter('a');
    warmer.enter('a');
    c.advance(100);
    expect(started).toEqual(['a']);
  });

  test('leaving lets the hold go after the grace, and coming back keeps it', () => {
    const { c, warmer, released } = setup();
    warmer.enter('a');
    c.advance(100);
    warmer.leave('a');
    c.advance(500);
    warmer.enter('a');
    c.advance(5000 - 600);
    expect(released).toEqual([]);
    warmer.leave('a');
    c.advance(1000);
    expect(released).toEqual(['a']);
  });

  test('opening releases the hold at once', () => {
    const { c, warmer, released } = setup();
    warmer.enter('a');
    c.advance(100);
    warmer.opened('a');
    expect(released).toEqual(['a']);
    warmer.opened('a');
    expect(released).toEqual(['a']);
  });

  test('a read already made is not made again until its time is up', () => {
    const { c, warmer, started } = setup({ holds: false });
    warmer.enter('a');
    c.advance(100);
    warmer.leave('a');
    c.advance(1000);
    warmer.enter('a');
    c.advance(100);
    expect(started).toEqual(['a']);
    c.advance(5000);
    warmer.enter('a');
    c.advance(100);
    expect(started).toEqual(['a', 'a']);
  });

  test('a keyboard focus is the same intent as a hover', () => {
    const { c, warmer, started } = setup({ delayMs: 0 });
    warmer.enter('b');
    c.advance(0);
    expect(started).toEqual(['b']);
  });
});

describe('the defaults', () => {
  test('are 120 ms to rest, 8 s of grace and 60 s before a repeat', () => {
    expect(PREFETCH_DELAY_MS).toBe(120);
    expect(PREFETCH_GRACE_MS).toBe(8_000);
    expect(PREFETCH_TTL_MS).toBe(60_000);
    const c = clock();
    const started: string[] = [];
    const released: string[] = [];
    const w = createWarmer({
      set: c.set,
      clear: c.clear,
      now: c.now,
      start: (key) => {
        started.push(key);
        return () => released.push(key);
      },
    });
    w.enter('a');
    c.advance(119);
    expect(started).toEqual([]);
    c.advance(1);
    expect(started).toEqual(['a']);
    w.leave('a');
    c.advance(7_999);
    expect(released).toEqual([]);
    c.advance(1);
    expect(released).toEqual(['a']);
  });

  test('a read that holds nothing is not repeated for 60 s', () => {
    const c = clock();
    let reads = 0;
    const w = createWarmer({
      set: c.set,
      clear: c.clear,
      now: c.now,
      start: () => {
        reads++;
        return undefined;
      },
    });
    w.enter('a');
    c.advance(120);
    w.leave('a');
    c.advance(59_000);
    w.enter('a');
    c.advance(120);
    expect(reads).toBe(1);
    c.advance(1_000);
    w.enter('a');
    c.advance(120);
    expect(reads).toBe(2);
  });
});

describe('one hold at a time (exclusive)', () => {
  test('a new intent lets go of the hold before it, at once', () => {
    const { c, warmer, started, released } = setup({ exclusive: true });
    warmer.enter('a');
    c.advance(100);
    warmer.enter('b');
    expect(released).toEqual(['a']);
    c.advance(100);
    expect(started).toEqual(['a', 'b']);
  });

  test('an intent still waiting is dropped by the next one', () => {
    const { c, warmer, started } = setup({ exclusive: true });
    warmer.enter('a');
    c.advance(50);
    warmer.enter('b');
    c.advance(100);
    expect(started).toEqual(['b']);
  });

  test('a hold let go can be taken again', () => {
    const { c, warmer, started } = setup({ exclusive: true });
    warmer.enter('a');
    c.advance(100);
    warmer.enter('b');
    c.advance(100);
    warmer.enter('a');
    c.advance(100);
    expect(started).toEqual(['a', 'b', 'a']);
  });

  test('releaseExcept keeps the hold of the row a dialog opens on', () => {
    const { c, warmer, released } = setup();
    warmer.enter('a');
    c.advance(100);
    warmer.enter('b');
    c.advance(100);
    warmer.releaseExcept('b');
    expect(released).toEqual(['a']);
    warmer.opened('b');
    expect(released).toEqual(['a', 'b']);
  });
});

describe('enabled and destroy', () => {
  test('nothing starts while it is switched off, and a pending read is dropped', () => {
    let on = true;
    const { c, warmer, started } = setup({ enabled: () => on });
    warmer.enter('a');
    on = false;
    c.advance(100);
    expect(started).toEqual([]);
    warmer.enter('b');
    c.advance(100);
    expect(started).toEqual([]);
  });

  test('destroy drops a pending read, lets go of holds and ignores later intent', () => {
    const { c, warmer, started, released } = setup();
    warmer.enter('a');
    c.advance(100);
    warmer.leave('a');
    warmer.enter('b');
    warmer.destroy();
    c.advance(100_000);
    expect(started).toEqual(['a']);
    expect(released).toEqual(['a']);
    warmer.enter('c');
    c.advance(100);
    expect(started).toEqual(['a']);
  });
});

// An element that records its listeners.
function fakeEl(focusVisible = true) {
  const handlers = new Map<string, (event: Event) => void>();
  return {
    el: {
      addEventListener: (type: string, fn: (e: Event) => void) =>
        handlers.set(type, fn),
      removeEventListener: (type: string) => handlers.delete(type),
      matches: (q: string) => q === ':focus-visible' && focusVisible,
    } as unknown as HTMLElement,
    fire: (type: string, init: object = {}) =>
      handlers.get(type)?.(init as Event),
    count: () => handlers.size,
  };
}

describe('intentOn', () => {
  const spy = () => {
    const calls: string[] = [];
    return {
      calls,
      warmer: {
        enter: (k: string) => calls.push(`enter ${k}`),
        leave: (k: string) => calls.push(`leave ${k}`),
      },
    };
  };

  test('a mouse hover and a keyboard focus enter; leaving and blur leave', () => {
    const { calls, warmer } = spy();
    const f = fakeEl();
    intentOn(f.el, warmer, () => 'k');
    f.fire('pointerenter', { pointerType: 'mouse' });
    f.fire('pointerleave');
    f.fire('focus');
    f.fire('blur');
    expect(calls).toEqual(['enter k', 'leave k', 'enter k', 'leave k']);
  });

  test('a touch enters nothing, nor does the focus its tap gives', () => {
    const { calls, warmer } = spy();
    const f = fakeEl();
    intentOn(f.el, warmer, () => 'k');
    f.fire('pointerenter', { pointerType: 'touch' });
    f.fire('pointerdown', { pointerType: 'touch' });
    f.fire('focus');
    expect(calls).toEqual([]);
    f.fire('focus');
    expect(calls).toEqual(['enter k']);
  });

  test('focus that is not a keyboard reaching the control enters nothing', () => {
    const { calls, warmer } = spy();
    const f = fakeEl(false);
    intentOn(f.el, warmer, () => 'k');
    f.fire('focus');
    expect(calls).toEqual([]);
  });

  test('the cleanup takes every listener off', () => {
    const { warmer } = spy();
    const f = fakeEl();
    const off = intentOn(f.el, warmer, () => 'k');
    expect(f.count()).toBe(5);
    off();
    expect(f.count()).toBe(0);
  });
});

describe('focus after another key', () => {
  test('focus a closing dialog hands back enters nothing; a Tab does', () => {
    const calls: string[] = [];
    const f = fakeEl();
    intentOn(f.el, { enter: (k) => calls.push(k), leave: () => {} }, () => 'k');
    noteKey('Escape');
    f.fire('focus');
    expect(calls).toEqual([]);
    noteKey('Tab');
    f.fire('focus');
    expect(calls).toEqual(['k']);
  });
});
