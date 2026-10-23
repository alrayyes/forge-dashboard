/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import {
  type FilterableItem,
  releaseAllHeld,
  type SharedFilterState,
} from './filters';
import { SharedPicks, savePick } from './shared-picks';

// The Dashboard and Insights share one wiring for the Label, Repo and Author
// controls. A control is redrawn only when what it shows changes.

const item = (repo: string, author: string): FilterableItem => ({
  forge: 'github',
  repo,
  title: 't',
  author,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
const state = (shared: Record<string, string> = {}): SharedFilterState => ({
  shared,
  pr: {},
  issue: {},
  view: {},
});
const fake = () => {
  const calls: unknown[][] = [];
  return {
    calls,
    render: (...args: unknown[]) => calls.push(args),
    announce: () => {},
    destroy: () => {},
  };
};

afterEach(() => releaseAllHeld());

describe('SharedPicks.refresh', () => {
  const pool = [item('acme/api', 'ann'), item('acme/web', 'bob')];

  test('draws each control once, and not again while nothing changed', () => {
    const picks = new SharedPicks(() => undefined);
    const repo = fake();
    const author = fake();
    const label = fake();
    Object.assign(picks, { repo, author, label });
    const s = state();
    picks.refresh(s, () => pool, false);
    picks.refresh(s, () => pool, false);
    expect([
      repo.calls.length,
      author.calls.length,
      label.calls.length,
    ]).toEqual([1, 1, 1]);
  });

  test('draws a control again when its choices or ticks change', () => {
    const picks = new SharedPicks(() => undefined);
    const repo = fake();
    Object.assign(picks, { repo, author: fake(), label: fake() });
    const s = state();
    picks.refresh(s, () => pool, false);
    picks.refresh(s, () => [pool[0]], false);
    expect(repo.calls).toHaveLength(2);
    savePick(s, 'repo', ['github:acme/api']);
    picks.refresh(s, () => [pool[0]], false);
    expect(repo.calls).toHaveLength(3);
  });

  test('sets aside a saved pick the page does not offer', () => {
    const picks = new SharedPicks(() => undefined);
    const s = state({ author: 'github:ann\ngithub:gone' });
    expect(picks.refresh(s, () => pool, false)).toBe(true);
    expect(s.shared.author).toBe('github:ann');
  });
});

describe('savePick', () => {
  test('saves lowercase values joined by a newline', () => {
    const s = state();
    savePick(s, 'author', ['ann', 'bob']);
    expect(s.shared.author).toBe('ann\nbob');
  });
});
