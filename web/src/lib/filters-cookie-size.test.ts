/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  COOKIE_LIMIT,
  fitToCookie,
  loadState,
  releaseAllHeld,
  type SharedFilterState,
  saveState,
  setCookieTrimmedHandler,
} from './filters';

// Three full picks and a long multibyte title together go past what a browser
// keeps in one cookie, and it drops the whole cookie without a word. The writer
// now cuts on purpose, within the limit, and says what it cut.
// https://github.com/alrayyes/forge-dashboard/issues/2619

let written = '';
let cut: string[][] = [];

beforeEach(() => {
  written = '';
  cut = [];
  releaseAllHeld();
  Object.assign(globalThis, {
    document: {
      get cookie() {
        return written;
      },
      set cookie(v: string) {
        written = v.split(';')[0];
      },
    },
  });
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response('{}', { status: 200 }),
    )) as unknown as typeof fetch;
  setCookieTrimmedHandler((names) => cut.push(names));
});

afterEach(() => {
  setCookieTrimmedHandler(null);
  releaseAllHeld();
});

const names = (prefix: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `${prefix}-${String(i).padStart(2, '0')}-${'x'.repeat(30)}`,
  );

const state = (
  shared: Record<string, string>,
  issue = {},
): SharedFilterState => ({
  shared,
  pr: {},
  issue,
  view: {},
});

const LITERAL_LIMIT = 3800;

describe('the filter cookie writer', () => {
  test('the limit leaves room under what a browser keeps', () => {
    expect(COOKIE_LIMIT).toBe(LITERAL_LIMIT);
  });

  test('cuts only the title search when that is enough, picks untouched', () => {
    const labels = names('label', 20);
    saveState(
      state({
        label: labels.join('\n'),
        repo: names('repo', 20).join('\n'),
        author: names('who', 20).join('\n'),
        title: '漢'.repeat(200),
      }),
    );
    expect(written.length).toBeLessThanOrEqual(LITERAL_LIMIT);
    expect(cut).toEqual([['the title search']]);
    expect(loadState().shared.label?.split('\n')).toHaveLength(20);
  });

  test('cuts the last names of the largest pick, one by one, after the title', () => {
    const label = names('label', 90);
    const { state: fitted, cut: gone } = fitToCookie(
      state({
        label: label.join('\n'),
        repo: names('repo', 10).join('\n'),
        author: names('who', 10).join('\n'),
        title: 'short',
      }),
      1,
    );
    expect(gone[0]).toBe('the title search');
    const labelCuts = gone.slice(1);
    expect(labelCuts.length).toBeGreaterThan(0);
    // The last names go first, in reverse order, and only as many as needed.
    expect(labelCuts).toEqual(label.slice(-labelCuts.length).reverse());
    expect(fitted.shared.label?.split('\n')).toEqual(
      label.slice(0, label.length - labelCuts.length),
    );
    expect(fitted.shared.repo?.split('\n')).toHaveLength(10);
    expect(
      encodeURIComponent(JSON.stringify({ ...fitted, rev: 1 })).length,
    ).toBeLessThanOrEqual(LITERAL_LIMIT);
  });

  test('picks the largest pick by encoded bytes, not by characters', () => {
    const cjk = Array.from({ length: 20 }, (_, i) => `${'漢'.repeat(14)}${i}`);
    const ascii = names('label', 60);
    const { cut: gone } = fitToCookie(
      state({ label: ascii.join('\n'), author: cjk.join('\n') }),
      1,
    );
    expect(gone.length).toBeGreaterThan(0);
    expect(gone[0]).toBe(cjk[cjk.length - 1]);
  });

  test('names a repo without its forge, with picks from two forges', () => {
    const repos = [
      ...Array.from(
        { length: 50 },
        (_, i) => `github:acme/repo-${i}-${'y'.repeat(30)}`,
      ),
      ...Array.from(
        { length: 50 },
        (_, i) => `forgejo:acme/repo-${i}-${'z'.repeat(30)}`,
      ),
    ];
    const { cut: gone, state: fitted } = fitToCookie(
      state({ repo: repos.join('\n'), author: 'ryan' }),
      1,
    );
    expect(gone[0]).toBe(`acme/repo-49-${'z'.repeat(30)}`);
    expect(
      fitted.shared.repo?.endsWith(repos[repos.length - gone.length - 1]),
    ).toBe(true);
    expect(fitted.shared.author).toBe('ryan');
  });

  test('cuts other saved values when no pick is left, and still says so', () => {
    const { cut: gone, state: fitted } = fitToCookie(
      state({ author: 'ryan' }, { hideTitleRegex: 'a'.repeat(5000) }),
      1,
    );
    expect(gone).toContain('the hideTitleRegex filter');
    expect(fitted.issue.hideTitleRegex).toBeUndefined();
    expect(
      encodeURIComponent(JSON.stringify({ ...fitted, rev: 1 })).length,
    ).toBeLessThanOrEqual(LITERAL_LIMIT);
  });

  test('writes everything and says nothing when it fits', () => {
    saveState(
      state({
        title: 'short',
        label: 'bug',
        repo: 'github:acme/app',
        author: 'ryan',
      }),
    );
    expect(cut).toHaveLength(0);
    expect(loadState().shared.title).toBe('short');
  });
});
