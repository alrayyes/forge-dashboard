/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createReferencePrefetcher } from './reference-prefetch';

// https://github.com/alrayyes/forge-dashboard/issues/4269
// A mention of an item in an untracked repository stays a forge link. The
// forge is asked while the pointer or focus rests on it, and a click opens the
// dialog only if that answer is already in; otherwise the link just works.
const ref = { forge: 'github', repo: 'o/r', number: 9 };

function setup(probe: () => Promise<unknown | null>, now = () => 0) {
  const known = new Set<string>();
  const log: string[] = [];
  const key = (r: typeof ref) => `${r.forge}|${r.repo}|${r.number}`;
  const prefetch = createReferencePrefetcher({
    probe: () => {
      log.push('probe');
      return probe();
    },
    isKnown: (r) => known.has(key(r)),
    remember: (r) => {
      log.push('remember');
      known.add(key(r));
    },
    now,
  });
  return { prefetch, log };
}

describe('createReferencePrefetcher', () => {
  test('asks the forge once and remembers what it showed', async () => {
    const { prefetch, log } = setup(async () => ({ state: 'closed' }));
    await prefetch.warm(ref);
    expect(log).toEqual(['probe', 'remember']);
    expect(prefetch.isReady(ref)).toBe(true);
  });

  test('a second warm while the first waits joins it', async () => {
    let release: (v: unknown) => void = () => {};
    const { prefetch, log } = setup(() => new Promise((r) => (release = r)));
    const first = prefetch.warm(ref);
    const second = prefetch.warm(ref);
    release({});
    await Promise.all([first, second]);
    expect(log.filter((l) => l === 'probe')).toHaveLength(1);
  });

  test('is not ready until the answer is in', async () => {
    let release: (v: unknown) => void = () => {};
    const { prefetch } = setup(() => new Promise((r) => (release = r)));
    const pending = prefetch.warm(ref);
    expect(prefetch.isReady(ref)).toBe(false);
    release({});
    await pending;
    expect(prefetch.isReady(ref)).toBe(true);
  });

  test('an item already read is ready and is not asked for again', async () => {
    const { prefetch, log } = setup(async () => ({}));
    await prefetch.warm(ref);
    await prefetch.warm(ref);
    expect(log).toEqual(['probe', 'remember']);
  });

  test('a failed lookup is not remembered, and is retried only after a pause', async () => {
    let t = 0;
    let answer: unknown | null = null;
    const { prefetch, log } = setup(
      async () => answer,
      () => t,
    );
    await prefetch.warm(ref);
    expect(prefetch.isReady(ref)).toBe(false);
    await prefetch.warm(ref);
    expect(log.filter((l) => l === 'probe')).toHaveLength(1);
    t = 60_000;
    answer = {};
    await prefetch.warm(ref);
    expect(log.filter((l) => l === 'probe')).toHaveLength(2);
    expect(prefetch.isReady(ref)).toBe(true);
  });
});
