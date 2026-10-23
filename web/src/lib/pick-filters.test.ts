/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import {
  authorChoices,
  type FilterableItem,
  heldPickNote,
  heldPicks,
  matchesFilters,
  reconcilePick,
  releaseAllHeld,
  repoChoices,
  type SharedFilterState,
  saveState,
  takeMigratedAuthor,
} from './filters';
import { initialOf, pickSummary, REPO_CONFIG } from './label-filter';

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

afterEach(() => {
  releaseAllHeld();
  takeMigratedAuthor();
});

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
    expect(
      run({ author: 'github:ann\ngithub:bob' }, item('github', 'a/b', 'Bob')),
    ).toBe(true);
  });
  test('an item by neither fails, and a part of a login is not enough', () => {
    const author = 'github:ann\ngithub:bob';
    expect(run({ author }, item('github', 'a/b', 'carol'))).toBe(false);
    expect(run({ author }, item('github', 'a/b', 'annabel'))).toBe(false);
  });
  test('a single saved author still matches', () => {
    expect(run({ author: 'github:ann' }, item('github', 'a/b', 'ann'))).toBe(
      true,
    );
  });
  test('the same login on another forge is another person', () => {
    const pick = { author: 'github:sam' };
    expect(run(pick, item('github', 'a/b', 'sam'))).toBe(true);
    expect(run(pick, item('forgejo', 'a/b', 'sam'))).toBe(false);
  });
  test('one saved login is the whole login, in any case, not a part of one', () => {
    // The author filter once matched any login containing the saved text.
    // Both controls now match the whole login, as the list offered it.
    const ann = { author: 'github:ann' };
    expect(run(ann, item('github', 'a/b', 'ANN'))).toBe(true);
    expect(run(ann, item('github', 'a/b', 'annabel'))).toBe(false);
    expect(
      run({ author: 'github:bel' }, item('github', 'a/b', 'annabel')),
    ).toBe(false);
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
  test('authors carry the first avatar seen, once each per forge, sorted', () => {
    const choices = authorChoices([
      item('github', 'a/b', 'Bob'),
      item('github', 'a/b', 'ann', { authorAvatarUrl: 'https://a/ann.png' }),
      item('github', 'a/b', 'bob', { authorAvatarUrl: 'https://a/bob.png' }),
    ]);
    expect(choices.map((c) => [c.value, c.text, c.group, c.imageUrl])).toEqual([
      ['github:ann', 'ann', undefined, 'https://a/ann.png'],
      ['github:bob', 'Bob', undefined, 'https://a/bob.png'],
    ]);
  });
  test('one login on two forges is two choices, under each forge', () => {
    const choices = authorChoices([
      item('github', 'a/b', 'sam', { authorAvatarUrl: 'https://a/g.png' }),
      item('forgejo', 'a/c', 'Sam', { authorAvatarUrl: 'https://a/f.png' }),
      item('forgejo', 'a/c', 'zed'),
    ]);
    expect(choices.map((c) => [c.value, c.text, c.group, c.imageUrl])).toEqual([
      ['forgejo:sam', 'Sam', 'Forgejo', 'https://a/f.png'],
      ['forgejo:zed', 'zed', 'Forgejo', undefined],
      ['github:sam', 'sam', 'GitHub', 'https://a/g.png'],
    ]);
  });
  test('a lone author on two forges is named with its forge', () => {
    const both = authorChoices([
      item('github', 'a/b', 'sam'),
      item('forgejo', 'a/c', 'sam'),
    ]);
    expect(
      pickSummary(['forgejo:sam'], both, { all: 'All', many: 'authors' }),
    ).toBe('sam (Forgejo)');
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
  test('one repo on two forges is named with its forge', () => {
    const both = repoChoices(
      [item('github', 'acme/api', 'x'), item('forgejo', 'acme/api', 'x')],
      () => undefined,
    );
    expect(pickSummary(['forgejo:acme/api'], both, words)).toBe(
      'acme/api (Forgejo)',
    );
    expect(pickSummary(['github:acme/api'], both, words)).toBe(
      'acme/api (GitHub)',
    );
  });
  test('a pick nothing offers is named from its value', () => {
    expect(
      pickSummary(['github:gone/x'], repos, words, REPO_CONFIG.unoffered),
    ).toBe('gone/x');
  });
  test('a label with a colon keeps it when nothing offers it', () => {
    expect(
      pickSummary(['kind:bug'], [], { all: 'All labels', many: 'labels' }),
    ).toBe('kind:bug');
  });
  test('the initial of a name, upper case, for the fallback', () => {
    expect(initialOf('ann')).toBe('A');
    expect(initialOf('')).toBe('?');
    expect(initialOf('acme/web')).toBe('A');
  });
});

describe('a hand-edited partial login', () => {
  test('is set aside and named in the held note, not matched by part', () => {
    const s: SharedFilterState = {
      shared: { author: 'github:ren' },
      pr: {},
      issue: {},
      view: {},
    };
    expect(reconcilePick(s, 'author', ['github:renovate[bot]'], true)).toBe(
      true,
    );
    expect(s.shared.author).toBe('');
    expect(heldPicks().map((h) => h.text)).toEqual(['ren']);
  });
});

describe('an author saved as a bare login by an earlier release', () => {
  const state = (author: string): SharedFilterState => ({
    shared: { author },
    pr: {},
    issue: {},
    view: {},
  });
  test('reads as every forge-qualified choice with that whole login', () => {
    const s = state('ryan');
    const offered = ['forgejo:ryan', 'github:ann', 'github:ryan'];
    expect(reconcilePick(s, 'author', offered, true)).toBe(false);
    expect(s.shared.author).toBe('forgejo:ryan\ngithub:ryan');
    expect(heldPicks()).toEqual([]);
    expect(takeMigratedAuthor()).toBe(true);
    expect(takeMigratedAuthor()).toBe(false);
  });
  test('matches the login in any case and keeps the other picks', () => {
    const s = state('Ryan\ngithub:ann');
    reconcilePick(s, 'author', ['github:ann', 'github:ryan'], false);
    expect(s.shared.author).toBe('github:ryan\ngithub:ann');
  });
  test('is not matched by part of a login', () => {
    const s = state('ry');
    expect(reconcilePick(s, 'author', ['github:ryan'], true)).toBe(true);
    expect(s.shared.author).toBe('');
    expect(takeMigratedAuthor()).toBe(false);
  });
  test('on no forge here is set aside and named without a forge', () => {
    const s = state('ghost');
    expect(reconcilePick(s, 'author', ['github:ryan'], true)).toBe(true);
    expect(s.shared.author).toBe('');
    const [pick] = heldPicks();
    expect(heldPickNote(pick)).toBe(
      'Saved author "ghost" has no forge and is not on this page.',
    );
  });
  test('a held bare login is rewritten in the saved copy too', () => {
    const s = state('ghost');
    reconcilePick(s, 'author', ['github:x'], true);
    reconcilePick(s, 'author', ['github:ghost', 'forgejo:ghost'], true);
    expect(heldPicks().map((h) => h.text)).toEqual(['ghost, ghost']);
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
    const s = state({ author: 'github:ann\ngithub:gone' });
    expect(reconcilePick(s, 'author', ['github:ann'], false)).toBe(true);
    expect(s.shared.author).toBe('github:ann');
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
    const s = state({ author: 'github:ann\ngithub:gone' });
    reconcilePick(s, 'author', ['github:ann'], true);
    saveState(s);
    globalThis.fetch = realFetch;
    expect(puts[0].shared.author).toBe('github:ann\ngithub:gone');
  });
});
