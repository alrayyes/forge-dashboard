import { describe, expect, it } from 'vitest';
import { dropsFailingMerge } from './failing-merge';

describe('dropsFailingMerge (#4953)', () => {
  it('draws no Merge on a row whose CI is failing', () => {
    expect(dropsFailingMerge('checks_failing', true)).toBe(true);
  });

  it('keeps the pop-up footer listing the locked Merge', () => {
    expect(dropsFailingMerge('checks_failing', false)).toBe(false);
  });

  it('leaves every other blocked reason to its own rule', () => {
    expect(dropsFailingMerge('conflict', true)).toBe(false);
    expect(dropsFailingMerge('draft', true)).toBe(false);
    expect(dropsFailingMerge('behind', true)).toBe(false);
    expect(dropsFailingMerge(undefined, true)).toBe(false);
  });
});
