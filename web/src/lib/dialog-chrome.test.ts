/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { chromeIsCurrent } from './dialog-chrome';

// The open dialog's footer is redrawn only when what it shows or what its
// buttons act on changed (#4327). Every snapshot hands the board new objects,
// so the same pull request arrives as a different object each poll.

const pr = (over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: 'a/b',
  number: 1,
  ci: 'success',
  ...over,
});

describe('chromeIsCurrent', () => {
  const shown = { sig: 'markup', item: pr() };

  test('holds for the same markup and the same item', () => {
    expect(chromeIsCurrent(shown, { sig: 'markup', item: shown.item })).toBe(
      true,
    );
  });

  test('holds for a new object with the same content', () => {
    expect(chromeIsCurrent(shown, { sig: 'markup', item: pr() })).toBe(true);
  });

  test('fails when the markup differs', () => {
    expect(chromeIsCurrent(shown, { sig: 'other', item: pr() })).toBe(false);
  });

  test('fails when the item changed under identical markup', () => {
    expect(
      chromeIsCurrent(shown, { sig: 'markup', item: pr({ ci: 'failure' }) }),
    ).toBe(false);
  });

  test('fails when the item went away or came back', () => {
    expect(chromeIsCurrent(shown, { sig: 'markup', item: undefined })).toBe(
      false,
    );
    expect(chromeIsCurrent({ sig: 'markup', item: undefined }, shown)).toBe(
      false,
    );
  });

  test('holds for no item twice', () => {
    expect(
      chromeIsCurrent(
        { sig: 'gone', item: undefined },
        { sig: 'gone', item: undefined },
      ),
    ).toBe(true);
  });
});
