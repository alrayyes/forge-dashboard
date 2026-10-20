/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  heldPicks,
  matchesFilters,
  reconcileLabels,
  releaseAllHeld,
  type SharedFilterState,
  saveState,
} from './filters';
import {
  hasLabel,
  joinLabels,
  labelSummary,
  narrowLabels,
  parseLabels,
  toggleLabel,
  unionLabels,
} from './label-filter';

// The Label filter holds a list of labels and matches an item carrying any of
// them. It is saved as one string so a single label saved before the list
// existed reads back as a list of one.

describe('parseLabels', () => {
  test('nothing saved is no labels', () => {
    expect(parseLabels(undefined)).toEqual([]);
    expect(parseLabels('')).toEqual([]);
  });

  test('a single saved label is a list of one', () => {
    expect(parseLabels('bug')).toEqual(['bug']);
    expect(parseLabels('kind/bug')).toEqual(['kind/bug']);
  });

  test('a label with a comma or a space stays whole', () => {
    expect(parseLabels('good first issue, again')).toEqual([
      'good first issue, again',
    ]);
  });

  test('several labels read back in order, lowercased, without repeats', () => {
    expect(parseLabels('bug\nSecurity\nBUG\n')).toEqual(['bug', 'security']);
  });
});

describe('joinLabels', () => {
  test('is the inverse of parseLabels for a list', () => {
    expect(parseLabels(joinLabels(['bug', 'docs']))).toEqual(['bug', 'docs']);
  });

  test('one label is saved exactly as a single label was before', () => {
    expect(joinLabels(['bug'])).toBe('bug');
    expect(joinLabels([])).toBe('');
  });
});

describe('hasLabel / toggleLabel', () => {
  test('ticking adds, unticking removes, case is ignored', () => {
    expect(toggleLabel(['bug'], 'Docs')).toEqual(['bug', 'docs']);
    expect(toggleLabel(['bug', 'docs'], 'BUG')).toEqual(['docs']);
    expect(hasLabel(['bug'], 'Bug')).toBe(true);
    expect(hasLabel(['bug'], 'docs')).toBe(false);
  });
});

describe('narrowLabels', () => {
  test('keeps the picks on offer and sets aside the ones that are not', () => {
    expect(
      narrowLabels(['bug', 'docs', 'gone'], ['Bug', 'Docs', 'Other']),
    ).toEqual({ kept: ['bug', 'docs'], dropped: ['gone'] });
  });

  test('everything stale is dropped', () => {
    expect(narrowLabels(['gone'], ['bug'])).toEqual({
      kept: [],
      dropped: ['gone'],
    });
  });
});

describe('unionLabels', () => {
  test('adds the set-aside labels to what is picked', () => {
    expect(unionLabels('bug', 'gone')).toBe('bug\ngone');
    expect(unionLabels('', 'gone')).toBe('gone');
    expect(unionLabels('bug', 'bug')).toBe('bug');
  });
});

describe('labelSummary', () => {
  const offered = ['Bug', 'Security', 'docs'];

  test('none picked says all labels', () => {
    expect(labelSummary([], offered)).toBe('All labels');
  });

  test('one picked names it as the page writes it', () => {
    expect(labelSummary(['bug'], offered)).toBe('Bug');
  });

  test('several picked say how many', () => {
    expect(labelSummary(['bug', 'docs'], offered)).toBe('2 labels');
  });
});

describe('matching any of the picked labels', () => {
  const item = (...names: string[]) => ({
    forge: 'github',
    repo: 'a/b',
    title: 't',
    author: 'x',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ci: 'success',
    labels: names.map((name) => ({ name })),
  });
  const run = (labels: string, ...names: string[]) =>
    matchesFilters(item(...names) as never, true, { label: labels }, undefined);

  test('an item with either label passes', () => {
    expect(run('bug\nsecurity', 'Security')).toBe(true);
    expect(run('bug\nsecurity', 'bug', 'docs')).toBe(true);
  });

  test('an item with neither fails', () => {
    expect(run('bug\nsecurity', 'docs')).toBe(false);
    expect(run('bug\nsecurity')).toBe(false);
  });

  test('a single saved label still matches as before', () => {
    expect(run('bug', 'Bug')).toBe(true);
    expect(run('bug', 'docs')).toBe(false);
  });

  test('no label picked lets everything through', () => {
    expect(run('', 'docs')).toBe(true);
  });
});

describe('labels the page does not offer', () => {
  const state = (label: string): SharedFilterState => ({
    shared: { label },
    pr: {},
    issue: {},
    view: {},
  });

  test('are set aside and the rest stay picked', () => {
    releaseAllHeld();
    const s = state('bug\ngone');
    expect(reconcileLabels(s, ['Bug', 'docs'], true)).toBe(true);
    expect(s.shared.label).toBe('bug');
    expect(heldPicks().map((p) => p.text)).toEqual(['gone']);
    releaseAllHeld();
  });

  test('stay in the saved copy while held, next to what is picked', () => {
    releaseAllHeld();
    const puts: SharedFilterState[] = [];
    const realFetch = globalThis.fetch;
    Object.assign(globalThis, { document: { cookie: '' } });
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      puts.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    const s = state('bug\ngone');
    reconcileLabels(s, ['bug'], true);
    saveState(s);
    globalThis.fetch = realFetch;
    expect(puts[0].shared.label).toBe('bug\ngone');
    releaseAllHeld();
  });

  test('are dropped for good when the user, not the page, narrowed them', () => {
    releaseAllHeld();
    const s = state('bug\ngone');
    expect(reconcileLabels(s, ['bug'], false)).toBe(true);
    expect(s.shared.label).toBe('bug');
    expect(heldPicks()).toEqual([]);
  });

  test('nothing is set aside when every pick is on offer', () => {
    const s = state('bug');
    expect(reconcileLabels(s, ['Bug'], true)).toBe(false);
    expect(s.shared.label).toBe('bug');
  });
});
