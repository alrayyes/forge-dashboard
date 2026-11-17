/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  hasTouched,
  heldPicks,
  holdStale,
  type SharedFilterState,
  touchKey,
} from './lib/filters';
import { resetFilterState } from './test-setup';

// A test that leaves filter state behind fails another one under some random
// orders (#4206). The preload clears it; these pin that it does, and that
// bun runs it. They read state and a file, so no order changes the outcome.
describe('the unit test preload', () => {
  // Every test here leaves state behind, then the next one checks it is gone.
  // Hooks run preload first, so only the preload can make this pass. It holds
  // in any order, since each test but the first follows a leaving one.
  afterEach(() => {
    touchKey('pr', 'ci');
    holdStale(
      { shared: { author: 'ryan' }, pr: {}, issue: {}, view: {} },
      'shared',
      'author',
    );
  });
  beforeEach(() => {
    expect(hasTouched()).toBe(false);
    expect(heldPicks()).toHaveLength(0);
  });

  test('clears touched keys and held picks', () => {
    const state: SharedFilterState = {
      shared: { author: 'ryan' },
      pr: {},
      issue: {},
      view: {},
    };
    touchKey('pr', 'ci');
    holdStale(state, 'shared', 'author');
    expect(hasTouched()).toBe(true);
    expect(heldPicks()).toHaveLength(1);

    resetFilterState();

    expect(hasTouched()).toBe(false);
    expect(heldPicks()).toHaveLength(0);
  });

  test('is named in bunfig.toml, so bun runs it before every test', () => {
    const bunfig = readFileSync(
      new URL('../../bunfig.toml', import.meta.url),
      'utf8',
    );
    const test = bunfig.split(/^\[test\]$/m)[1] ?? '';
    expect(test).toMatch(/preload\s*=\s*\[[^\]]*\.\/web\/src\/test-setup\.ts/);
  });
});
