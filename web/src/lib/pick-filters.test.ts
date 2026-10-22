/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import {
  authorChoices,
  type FilterableItem,
  heldPicks,
  matchesFilters,
  reconcilePick,
  releaseAllHeld,
  repoChoices,
  type SharedFilterState,
  saveState,
} from './filters';
import { initialOf, pickSummary } from './label-filter';

// The Repo and Author filters hold a list, like the Label filter: saved as one
// lowercase string joined by a newline, so a value saved before the list
// existed reads back as a list of one, and an item matches when it fits any.

const item = (
  forge: string,
  repo: string,
  author: string,
  extra: Partial<FilterableItem> = {},
): FilterableItem => ({
  forge,
  repo,
  title: 't',
  author,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...extra,
});
const run = (shared: Record<string, string>, i: FilterableItem) =>
  matchesFilters(i, true, shared, undefined);

afterEach(() => releaseAllHeld());

describe('matching any of the picked repos', () => {
  const pick = 'github:acme/api\nforgejo:acme/docs';
  test('an item in either repo passes, in any case', () => {
    expect(run({ repo: pick }, item('github', 'Acme/API', 'x'))).toBe(true);
    expect(run({ repo: pick }, item('forgejo', 'acme/docs', 'x'))).toBe(true);
  });
  test('the same name on the other forge fails', () => {
    expect(run({ repo: pick }, item('forgejo', 'acme/api', 'x'))).toBe(false);
  });
  test('a single saved repo still matches as before', () => {
    expect(
      run({ repo: 'github:acme/api' }, item('github', 'acme/api', 'x')),
    ).toBe(true);
    expect(
      run({ repo: 'github:acme/api' }, item('github', 'acme/web', 'x')),
    ).toBe(false);
  });
  test('no repo picked lets everything through', () => {
    expect(run({ repo: '' }, item('github', 'a/b', 'x'))).toBe(true);
  });
});

describe('matching any of the picked authors', () => {
  test('an item by either author passes, in any case', () => {
    expect(run({ author: 'ann\nbob' }, item('github', 'a/b', 'Bob'))).toBe(
      true,
    );
  });
  test('an item by neither fails, and a part of a login is not enough', () => {
    expect(run({ author: 'ann\nbob' }, item('github', 'a/b', 'carol'))).toBe(
      false,
    );
    expect(run({ author: 'ann\nbob' }, item('github', 'a/b', 'annabel'))).toBe(
      false,
    );
  });
  test('a single saved author still matches', () => {
    expect(run({ author: 'ann' }, item('github', 'a/b', 'ann'))).toBe(true);
  });
});

describe('choices', () => {
  test('repos are grouped by forge only when several forges show, with the logo', () => {
    const items = [
      item('github', 'acme/web', 'x'),
      item('forgejo', 'acme/api', 'x'),
      item('github', 'acme/web', 'y'),
    ];
    const logos: Record<string, string> = {
      'github:acme/web': 'https://l/w.png',
    };
    const choices = repoChoices(items, (key) => logos[key]);
    expect(choices.map((c) => [c.value, c.text, c.group, c.imageUrl])).toEqual([
      ['forgejo:acme/api', 'acme/api', 'Forgejo', undefined],
      ['github:acme/web', 'acme/web', 'GitHub', 'https://l/w.png'],
    ]);
    expect(repoChoices([items[0]], () => undefined)[0].group).toBeUndefined();
  });
  test('authors carry the first avatar seen, once each, sorted', () => {
    const choices = authorChoices([
      item('github', 'a/b', 'Bob'),
      item('github', 'a/b', 'ann', { authorAvatarUrl: 'https://a/ann.png' }),
      item('forgejo', 'a/c', 'bob', { authorAvatarUrl: 'https://a/bob.png' }),
    ]);
    expect(choices.map((c) => [c.value, c.text, c.imageUrl])).toEqual([
      ['ann', 'ann', 'https://a/ann.png'],
      ['bob', 'Bob', 'https://a/bob.png'],
    ]);
  });
});

describe('pickSummary and initialOf', () => {
  const repos = repoChoices(
    [item('github', 'acme/web', 'x'), item('github', 'acme/api', 'x')],
    () => undefined,
  );
  const words = { all: 'All repos', many: 'repos' };
  test('none, one and several', () => {
    expect(pickSummary([], repos, words)).toBe('All repos');
    expect(pickSummary(['github:acme/web'], repos, words)).toBe('acme/web');
    expect(
      pickSummary(['github:acme/web', 'github:acme/api'], repos, words),
    ).toBe('2 repos');
  });
  test('a pick nothing offers is named from its value', () => {
    expect(pickSummary(['github:gone/x'], repos, words)).toBe('gone/x');
  });
  test('the initial of a name, upper case, for the fallback', () => {
    expect(initialOf('ann')).toBe('A');
    expect(initialOf('')).toBe('?');
    expect(initialOf('acme/web')).toBe('A');
  });
});

describe('picks the page does not offer', () => {
  const state = (shared: Record<string, string>): SharedFilterState => ({
    shared,
    pr: {},
    issue: {},
    view: {},
  });
  test('repos are set aside and the rest stay picked, named without the forge', () => {
    const s = state({ repo: 'github:a/b\ngithub:gone/x' });
    expect(reconcilePick(s, 'repo', ['github:a/b'], true)).toBe(true);
    expect(s.shared.repo).toBe('github:a/b');
    expect(heldPicks().map((p) => p.text)).toEqual(['gone/x']);
  });
  test('authors are dropped for good after the user narrowed them', () => {
    const s = state({ author: 'ann\ngone' });
    expect(reconcilePick(s, 'author', ['ann'], false)).toBe(true);
    expect(s.shared.author).toBe('ann');
    expect(heldPicks()).toEqual([]);
  });
  test('held authors stay in the saved copy next to the picked', () => {
    const puts: SharedFilterState[] = [];
    const realFetch = globalThis.fetch;
    Object.assign(globalThis, { document: { cookie: '' } });
    globalThis.fetch = ((_u: string, init?: RequestInit) => {
      puts.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    const s = state({ author: 'ann\ngone' });
    reconcilePick(s, 'author', ['ann'], true);
    saveState(s);
    globalThis.fetch = realFetch;
    expect(puts[0].shared.author).toBe('ann\ngone');
  });
});
