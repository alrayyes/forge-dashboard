/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { dropsFailingMerge } from './failing-merge';

describe('dropsFailingMerge (#4953, #4975)', () => {
  it('draws no Merge when CI is failing and that is the blocked reason', () => {
    expect(dropsFailingMerge('failure', 'checks_failing')).toBe(true);
  });

  it('draws none when another reason is listed first (stacked)', () => {
    expect(dropsFailingMerge('failure', 'draft')).toBe(true);
    expect(dropsFailingMerge('failure', 'conflict')).toBe(true);
    expect(dropsFailingMerge('failure', 'behind')).toBe(true);
  });

  it('draws none for a mergeable pull request whose CI failed', () => {
    expect(dropsFailingMerge('failure', undefined)).toBe(true);
  });

  it('leaves every other state to its own rule', () => {
    expect(dropsFailingMerge('success', 'conflict')).toBe(false);
    expect(dropsFailingMerge('pending', 'behind')).toBe(false);
    expect(dropsFailingMerge('cancelled', undefined)).toBe(false);
    expect(dropsFailingMerge(undefined, undefined)).toBe(false);
  });
});
