import { describe, expect, test } from 'bun:test';
import {
  createDetailsCache,
  createPrefetcher,
  type DetailsRef,
  detailsKey,
} from './details-cache';

const ref = (number: number, over: Partial<DetailsRef> = {}): DetailsRef => ({
  forge: 'github',
  repo: 'o/r',
  subject: 'pull-request',
  number,
  ...over,
});

describe('details cache', () => {
  test('keys a pull request and an issue with the same number apart', () => {
    expect(detailsKey(ref(1))).not.toBe(
      detailsKey(ref(1, { subject: 'issue' })),
    );
    expect(detailsKey(ref(1))).not.toBe(
      detailsKey(ref(1, { forge: 'forgejo' })),
    );
    expect(detailsKey(ref(1))).not.toBe(detailsKey(ref(1, { repo: 'o/x' })));
  });

  test('returns what was stored and forgets what was deleted', () => {
    const cache = createDetailsCache<string>(5);
    cache.set(detailsKey(ref(1)), { details: 'a', readAt: 10 });
    expect(cache.get(detailsKey(ref(1)))?.details).toBe('a');
    cache.delete(detailsKey(ref(1)));
    expect(cache.get(detailsKey(ref(1)))).toBeUndefined();
  });

  test('is bounded and drops the least recently used entry', () => {
    const cache = createDetailsCache<string>(2);
    cache.set('a', { details: 'a', readAt: 1 });
    cache.set('b', { details: 'b', readAt: 2 });
    cache.get('a');
    cache.set('c', { details: 'c', readAt: 3 });
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.size()).toBe(2);
  });
});

function harness(delayMs = 150) {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const loads: number[] = [];
  const cache = createDetailsCache<string>(10);
  let release: (() => void)[] = [];
  const prefetcher = createPrefetcher<string>({
    delayMs,
    cache,
    now: () => 99,
    setTimer: (fn) => {
      timers.set(nextTimer, fn);
      return nextTimer++;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
    load: (r) =>
      new Promise((resolve) => {
        loads.push(r.number);
        release.push(() => resolve(`d${r.number}`));
      }),
  });
  const fire = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  const settle = async () => {
    for (const r of release) r();
    release = [];
    await Promise.resolve();
    await Promise.resolve();
  };
  return { cache, prefetcher, loads, fire, settle, timers };
}

describe('prefetcher', () => {
  test('reads nothing until the dwell has passed', () => {
    const h = harness();
    h.prefetcher.enter(ref(1));
    expect(h.loads).toEqual([]);
    h.fire();
    expect(h.loads).toEqual([1]);
  });

  test('moving across rows reads nothing', () => {
    const h = harness();
    h.prefetcher.enter(ref(1));
    h.prefetcher.leave();
    h.prefetcher.enter(ref(2));
    h.prefetcher.leave();
    h.fire();
    expect(h.loads).toEqual([]);
  });

  test('stores the answer with when it was read', async () => {
    const h = harness();
    h.prefetcher.enter(ref(1));
    h.fire();
    await h.settle();
    expect(h.cache.get(detailsKey(ref(1)))).toEqual({
      details: 'd1',
      readAt: 99,
    });
  });

  test('does not read what is already cached', () => {
    const h = harness();
    h.cache.set(detailsKey(ref(1)), { details: 'x', readAt: 1 });
    h.prefetcher.enter(ref(1));
    h.fire();
    expect(h.loads).toEqual([]);
  });

  test('does not read twice while one is in flight', () => {
    const h = harness();
    h.prefetcher.enter(ref(1));
    h.fire();
    h.prefetcher.leave();
    h.prefetcher.enter(ref(1));
    h.fire();
    expect(h.loads).toEqual([1]);
  });

  test('an answer that arrives after an invalidation is dropped', async () => {
    const h = harness();
    h.prefetcher.enter(ref(1));
    h.fire();
    h.cache.delete(detailsKey(ref(1)));
    await h.settle();
    expect(h.cache.get(detailsKey(ref(1)))).toBeUndefined();
  });

  test('a failed read stores nothing and does not throw', async () => {
    const cache = createDetailsCache<string>(10);
    let fn: (() => void) | undefined;
    const p = createPrefetcher<string>({
      cache,
      setTimer: (f) => {
        fn = f;
        return 1;
      },
      clearTimer: () => {},
      load: () => Promise.reject(new Error('down')),
    });
    p.enter(ref(1));
    fn?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.size()).toBe(0);
  });
});
