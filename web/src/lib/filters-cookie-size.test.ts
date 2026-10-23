/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  COOKIE_LIMIT,
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
    Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch;
  setCookieTrimmedHandler((names) => cut.push(names));
});

afterEach(() => {
  setCookieTrimmedHandler(null);
  releaseAllHeld();
});

const names = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}-${'x'.repeat(30)}`).join(
    '\n',
  );

const big = (): SharedFilterState => ({
  shared: {
    label: names('label', 20),
    repo: names('github:acme/repo', 20),
    author: names('author', 20),
    title: '漢'.repeat(200),
  },
  pr: {},
  issue: {},
  view: {},
});

describe('the filter cookie writer', () => {
  test('keeps the cookie under the limit when the picks and a multibyte title overflow it', () => {
    saveState(big());
    expect(written.length).toBeLessThanOrEqual(COOKIE_LIMIT);
    expect(written.length).toBeGreaterThan(0);
  });

  test('names what it cut, and the cookie still reads back', () => {
    saveState(big());
    expect(cut).toHaveLength(1);
    expect(cut[0].length).toBeGreaterThan(0);
    const state = loadState();
    expect(state.shared.label).toBeTruthy();
  });

  test('writes everything and says nothing when it fits', () => {
    const state = big();
    state.shared.title = 'short';
    state.shared.label = 'bug';
    state.shared.repo = 'github:acme/app';
    state.shared.author = 'ryan';
    saveState(state);
    expect(cut).toHaveLength(0);
    expect(loadState().shared.title).toBe('short');
  });
});
