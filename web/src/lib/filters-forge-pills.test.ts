/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  activePill,
  PILL_GROUPS,
  pillGroupOf,
  pillLabel,
  type SharedFilterState,
  setPill,
} from './filters';
import { registerForgeCapabilities, resetForgeCapabilities } from './forges';

// The forge pill group lists the forges the server reports, not a hard-coded
// pair (#3978).

const state = (): SharedFilterState => ({
  shared: {},
  pr: {},
  issue: {},
  view: {},
});

describe('forge pill group', () => {
  test('lists the two shipped forges, labelled', () => {
    expect([...PILL_GROUPS.forge]).toEqual(['github', 'forgejo']);
    expect(pillLabel('github')).toBe('GitHub');
    expect(pillLabel('forgejo')).toBe('Forgejo');
  });

  test('a registered gitea gets a pill, a label and a place in the group', () => {
    try {
      registerForgeCapabilities([
        { forge: 'gitea', capabilities: { label: 'Gitea' } },
      ]);
      expect([...PILL_GROUPS.forge]).toEqual(['github', 'forgejo', 'gitea']);
      expect(pillLabel('gitea')).toBe('Gitea');
      expect(pillGroupOf('gitea')).toBe('forge');
      const s = state();
      setPill(s, 'forge', 'gitea');
      expect(s.shared.forge).toBe('gitea');
      expect(activePill(s, 'forge')).toBe('gitea');
    } finally {
      resetForgeCapabilities();
    }
  });

  test('a forge nobody registered is no pill, and falls back to its id', () => {
    const s = state();
    setPill(s, 'forge', 'gitea');
    expect(s.shared.forge).toBe('');
    expect(pillLabel('gitea')).toBe('gitea');
  });

  test('the other groups keep their fixed pills and labels', () => {
    expect([...PILL_GROUPS.ci]).toEqual([
      'failing',
      'running',
      'passing',
      'cancelled',
      'no-checks',
    ]);
    expect(pillLabel('no-checks')).toBe('No checks');
    expect(pillLabel('review-requested')).toBe('Review requested');
  });
});
const ODD = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

describe('pillLabel inherited keys', () => {
  test.each(ODD)('%s is its own label', (pill) => {
    expect(pillLabel(pill)).toBe(pill);
  });
});
