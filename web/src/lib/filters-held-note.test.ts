/// <reference types="bun" />
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  heldPickClearLabel,
  heldPickNote,
  heldPicks,
  holdStale,
  releaseAllHeld,
  releaseHeld,
  type SharedFilterState,
} from './filters';

// What the page says about a saved pick it does not offer (#1620): one entry
// per held pick, named the way the control is and worded for a reader.
// https://github.com/alrayyes/forge-dashboard/issues/1620

beforeEach(() => releaseAllHeld());

function state(): SharedFilterState {
  return {
    shared: { author: 'ryan', repo: 'github:acme/docs', created: '10080' },
    pr: { status: 'failure' },
    issue: {},
    view: {},
  };
}

describe('heldPicks', () => {
  test('is empty when nothing was held', () => {
    expect(heldPicks()).toEqual([]);
  });

  test('names each held pick and says what it is', () => {
    const s = state();
    holdStale(s, 'shared', 'author');
    holdStale(s, 'shared', 'repo');
    holdStale(s, 'shared', 'created');
    holdStale(s, 'pr', 'status');
    expect(heldPicks().map((h) => [h.group, h.key, h.name, h.text])).toEqual([
      ['shared', 'author', 'author', 'ryan'],
      ['shared', 'repo', 'repo', 'acme/docs'],
      ['shared', 'created', 'created', '< 7 days'],
      ['pr', 'status', 'CI status', 'Failing'],
    ]);
  });

  test('does not list a control that had no pick', () => {
    const s = state();
    s.shared.label = '';
    holdStale(s, 'shared', 'label');
    expect(heldPicks()).toEqual([]);
  });

  test('forgets a pick the user released', () => {
    const s = state();
    holdStale(s, 'shared', 'author');
    releaseHeld('shared', 'author');
    expect(heldPicks()).toEqual([]);
  });
});

describe('wording', () => {
  test('names the control for a text kind', () => {
    const s = state();
    holdStale(s, 'shared', 'author');
    const [pick] = heldPicks();
    expect(heldPickNote(pick)).toBe('Saved author "ryan" is not on this page.');
    expect(heldPickClearLabel(pick)).toBe('Clear saved author "ryan"');
  });

  test('says "filter" and names the control for date and CI kinds', () => {
    const s = state();
    holdStale(s, 'shared', 'created');
    holdStale(s, 'pr', 'status');
    expect(heldPicks().map(heldPickNote)).toEqual([
      'Saved filter "Created: < 7 days" is not on this page.',
      'Saved filter "CI status: Failing" is not on this page.',
    ]);
  });

  test('cuts a long value short, in the note and the button name', () => {
    const s = state();
    s.shared.author = 'x'.repeat(300);
    holdStale(s, 'shared', 'author');
    const [pick] = heldPicks();
    expect(pick.text).toHaveLength(300);
    expect(heldPickNote(pick).length).toBeLessThan(90);
    expect(heldPickNote(pick)).toContain('…');
    expect(heldPickClearLabel(pick).length).toBeLessThan(90);
  });
});
