/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  forgeIds,
  registerForgeCapabilities,
  resetForgeCapabilities,
} from './forges';
import { forgeCounts, type MainBranch } from './main-branches';

// The forge pills list and count the forges the server reports, not a
// hard-coded pair (#3978).

const rows = (...forges: string[]) =>
  forges.map((forge) => ({ forge }) as unknown as MainBranch);

describe('forgeCounts', () => {
  test('counts the two shipped forges and the total', () => {
    expect(forgeCounts(rows('github', 'forgejo', 'github'))).toEqual({
      all: 3,
      github: 2,
      forgejo: 1,
    });
  });

  test('counts a registered third forge, and lists it in forgeIds', () => {
    try {
      registerForgeCapabilities([{ forge: 'gitea' }]);
      expect(forgeIds()).toEqual(['github', 'forgejo', 'gitea']);
      expect(forgeCounts(rows('gitea', 'github', 'gitea'))).toEqual({
        all: 3,
        github: 1,
        forgejo: 0,
        gitea: 2,
      });
    } finally {
      resetForgeCapabilities();
    }
  });
});

describe('forgeCounts for a forge named like an inherited key', () => {
  test.each(['constructor', '__proto__'])('%s is counted as a forge', (id) => {
    registerForgeCapabilities([{ forge: id }]);
    const counts = forgeCounts(rows(id, id, 'github'));

    expect(Object.hasOwn(counts, id)).toBe(true);
    expect(counts[id]).toBe(2);
    expect(Object.getPrototypeOf(counts)).toBe(Object.prototype);
    resetForgeCapabilities();
  });
});
