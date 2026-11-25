/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { clearStaleLocks } from './stale-locks';

// A snapshot re-derives a lock from what the server says now, so a lock left
// over from an earlier answer is dropped. Enable auto-merge on a stacked pull
// request locks with `stacked`; once the parent merges, the next snapshot has
// to free it with no reload.
type S = Record<string, { phase: string; code?: string }>;

describe('clearStaleLocks', () => {
  test('drops a locked entry in every map it is given', () => {
    const merge: S = { a: { phase: 'locked', code: 'stacked' } };
    const autoMerge: S = { a: { phase: 'locked', code: 'stacked' } };
    clearStaleLocks([merge, autoMerge], () => false);
    expect(merge).toEqual({});
    expect(autoMerge).toEqual({});
  });

  test('leaves an in-flight phase alone', () => {
    const autoMerge = { a: { phase: 'enabling' }, b: { phase: 'queued' } };
    clearStaleLocks([autoMerge], () => false);
    expect(Object.keys(autoMerge)).toEqual(['a', 'b']);
  });

  test('keeps a lock the caller says still stands', () => {
    const state = {
      a: { phase: 'locked', code: 'permission' },
      b: { phase: 'locked', code: 'stacked' },
    };
    clearStaleLocks([state], (e) => e.code === 'permission');
    expect(Object.keys(state)).toEqual(['a']);
  });
});

// The snapshot clear, the permission-lock release and the rate-limit reset all
// walk one list, `lockableStateMaps()` in Dashboard.svelte. A new action state
// map has to join it, or its lock outlives the data that caused it.
describe('the shared list of lockable state maps', () => {
  const source = readFileSync(
    new URL('./Dashboard.svelte', import.meta.url),
    'utf8',
  );
  // These two only ever hold 'requesting' or 'confirming', so they never lock.
  const neverLock = new Set(['cancelAutoMergeState', 'recreateState']);

  test('holds every action state map that can lock', () => {
    const declared = [
      ...source.matchAll(/const (\w+): Record<string, ActionState> = \{\};/g),
    ]
      .map((m) => m[1])
      .filter((name) => !neverLock.has(name));
    const body = source.match(
      /function lockableStateMaps\(\)[^{]*\{\s*return \[([^\]]*)\]/,
    );
    expect(body).not.toBeNull();
    const listed = (body?.[1] ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(listed.sort()).toEqual(declared.sort());
  });

  test('is the only place the maps are listed', () => {
    const uses = source.match(/lockableStateMaps\(\)/g) ?? [];
    // The definition and the three callers.
    expect(uses.length).toBe(4);
    // No second copy of the list under another name.
    expect(
      source.match(/updateBranchState,\s*autoMergeState,/g) ?? [],
    ).toHaveLength(1);
  });
});
