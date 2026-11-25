/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
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
