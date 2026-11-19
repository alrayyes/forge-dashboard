/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { referenceAt, referenceFromClick } from './reference-links';

// https://github.com/alrayyes/forge-dashboard/issues/3744
// A click on a rendered reference hands the dialog host the repository and
// number; a modified click is left to the browser so a new tab still works.
const anchor = {
  dataset: {
    refRepo: 'a/b',
    refNumber: '12',
    refUrl: 'https://github.com/a/b/issues/12',
  },
};
const click = (over: Record<string, unknown> = {}) => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target: {
    closest: (sel: string) => (sel === 'a[data-ref-number]' ? anchor : null),
  },
  ...over,
});

describe('referenceFromClick', () => {
  test('reads the reference off a plain click', () => {
    expect(referenceFromClick(click() as never)).toEqual({
      repo: 'a/b',
      number: 12,
      url: 'https://github.com/a/b/issues/12',
      untracked: false,
      anchor,
    });
  });

  // https://github.com/alrayyes/forge-dashboard/issues/4269
  test('says when the repository is one the dashboard does not track', () => {
    const untracked = { dataset: { ...anchor.dataset, refUntracked: '' } };
    const got = referenceFromClick(
      click({ target: { closest: () => untracked } }) as never,
    );
    expect(got?.untracked).toBe(true);
    expect(referenceFromClick(click() as never)?.untracked).toBe(false);
  });

  test('leaves a modified or middle click to the browser', () => {
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { button: 1 }]) {
      expect(referenceFromClick(click(over) as never)).toBeNull();
    }
  });

  test('ignores a click that is not on a reference', () => {
    expect(
      referenceFromClick(click({ target: { closest: () => null } }) as never),
    ).toBeNull();
  });

  test('ignores a malformed number', () => {
    const bad = { dataset: { ...anchor.dataset, refNumber: 'x' } };
    expect(
      referenceFromClick(click({ target: { closest: () => bad } }) as never),
    ).toBeNull();
  });
});

// https://github.com/alrayyes/forge-dashboard/issues/4269
describe('referenceAt', () => {
  test('reads the reference under the pointer or focus, with no click', () => {
    const untracked = { dataset: { ...anchor.dataset, refUntracked: '' } };
    const got = referenceAt({ closest: () => untracked });
    expect(got?.repo).toBe('a/b');
    expect(got?.untracked).toBe(true);
    expect(referenceAt({ closest: () => null })).toBeNull();
    expect(referenceAt(null)).toBeNull();
  });
});
