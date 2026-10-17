/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  addIgnoredTitle,
  ignoredCountLabel,
  ignoredCountsFrom,
  issueSettingsFrom,
  MAX_IGNORED_TITLES,
  MAX_PATTERN_LENGTH,
  normaliseIgnoredTitles,
} from './issue-settings';

describe('normaliseIgnoredTitles', () => {
  test('drops anything that is not an array', () => {
    for (const bad of [undefined, null, 'x', 3, {}, true])
      expect(normaliseIgnoredTitles(bad)).toEqual([]);
  });

  test('drops non-string, blank and over-long entries, trims the rest', () => {
    const long = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
    expect(
      normaliseIgnoredTitles([' ^Weekly report ', 4, null, '', '  ', long]),
    ).toEqual(['^Weekly report']);
  });

  test('keeps an entry of exactly the longest length', () => {
    const edge = 'a'.repeat(MAX_PATTERN_LENGTH);
    expect(normaliseIgnoredTitles([edge])).toEqual([edge]);
  });

  test('drops repeats, ignoring case', () => {
    expect(normaliseIgnoredTitles(['^Weekly', '^weekly', 'x'])).toEqual([
      '^Weekly',
      'x',
    ]);
  });

  test('keeps at most the cap', () => {
    const many = Array.from({ length: 30 }, (_, i) => `p${i}`);
    expect(normaliseIgnoredTitles(many)).toHaveLength(MAX_IGNORED_TITLES);
  });
});

describe('pattern length counts characters, not UTF-16 units', () => {
  const emoji = '\u{1F600}';

  test('keeps 200 non-BMP characters and drops 201', () => {
    expect(normaliseIgnoredTitles([emoji.repeat(200)])).toHaveLength(1);
    expect(normaliseIgnoredTitles([emoji.repeat(201)])).toEqual([]);
  });

  test('addIgnoredTitle accepts 200 non-BMP characters and refuses 201', () => {
    expect(addIgnoredTitle([], emoji.repeat(200)).error).toBeUndefined();
    expect(addIgnoredTitle([], emoji.repeat(200)).list).toHaveLength(1);
    const over = addIgnoredTitle([], emoji.repeat(201));
    expect(over.list).toEqual([]);
    expect(over.error).toContain(String(MAX_PATTERN_LENGTH));
  });
});

describe('issueSettingsFrom', () => {
  test('reads a response, treating missing fields as off and empty', () => {
    expect(issueSettingsFrom({})).toEqual({
      hideDependencyDashboard: false,
      ignoredTitles: [],
    });
    expect(issueSettingsFrom(null)).toEqual({
      hideDependencyDashboard: false,
      ignoredTitles: [],
    });
  });

  test('only a real true turns the setting on', () => {
    expect(
      issueSettingsFrom({ hideDependencyDashboard: 'true' })
        .hideDependencyDashboard,
    ).toBe(false);
    expect(
      issueSettingsFrom({
        hideDependencyDashboard: true,
        ignoredTitles: ['a'],
      }),
    ).toEqual({ hideDependencyDashboard: true, ignoredTitles: ['a'] });
  });
});

describe('addIgnoredTitle', () => {
  test('trims and appends', () => {
    expect(addIgnoredTitle(['a'], '  ^Weekly report ')).toEqual({
      list: ['a', '^Weekly report'],
    });
  });

  test('ignores blanks and repeats without an error', () => {
    expect(addIgnoredTitle(['a'], '   ')).toEqual({ list: ['a'] });
    expect(addIgnoredTitle(['^Weekly'], '^weekly')).toEqual({
      list: ['^Weekly'],
    });
  });

  test('refuses an over-long pattern and a full list in words', () => {
    const tooLong = addIgnoredTitle([], 'a'.repeat(MAX_PATTERN_LENGTH + 1));
    expect(tooLong.list).toEqual([]);
    expect(tooLong.error).toContain(String(MAX_PATTERN_LENGTH));
    const full = Array.from({ length: MAX_IGNORED_TITLES }, (_, i) => `p${i}`);
    const over = addIgnoredTitle(full, 'one more');
    expect(over.list).toEqual(full);
    expect(over.error).toContain(String(MAX_IGNORED_TITLES));
  });
});

describe('ignoredCountLabel', () => {
  test('says zero, one and many in plain words', () => {
    expect(ignoredCountLabel(0, true)).toBe('hides no issues');
    expect(ignoredCountLabel(1, true)).toBe('hides 1 issue');
    expect(ignoredCountLabel(3, true)).toBe('hides 3 issues');
  });

  test('says nothing while the count is unknown, never a made-up 0', () => {
    for (const unknown of [null, undefined, -1, 1.5, NaN, '3' as never])
      expect(ignoredCountLabel(unknown, true)).toBe('');
  });

  test('a pattern that is not saved yet is counted after the save', () => {
    expect(ignoredCountLabel(undefined, false)).toBe('Counted after you save');
    expect(ignoredCountLabel(4, false)).toBe('Counted after you save');
  });
});

describe('ignoredCountsFrom', () => {
  test('pairs each pattern with its count, nulls kept as unknown', () => {
    const counts = ignoredCountsFrom({
      ignoredTitles: ['a', 'b', 'c'],
      ignoredTitleCounts: [3, 0, null],
    });
    expect(counts?.get('a')).toBe(3);
    expect(counts?.get('b')).toBe(0);
    expect(counts?.get('c')).toBeNull();
  });

  test('a missing or mismatched field means no counts at all', () => {
    expect(ignoredCountsFrom({ ignoredTitles: ['a'] })).toBeNull();
    expect(ignoredCountsFrom(null)).toBeNull();
    expect(
      ignoredCountsFrom({ ignoredTitles: ['a', 'b'], ignoredTitleCounts: [1] }),
    ).toBeNull();
    expect(
      ignoredCountsFrom({ ignoredTitles: ['a'], ignoredTitleCounts: 'x' }),
    ).toBeNull();
  });

  test('a bad entry is unknown, not zero', () => {
    const counts = ignoredCountsFrom({
      ignoredTitles: ['a', 'b'],
      ignoredTitleCounts: [-2, 'x'],
    });
    expect(counts?.get('a')).toBeNull();
    expect(counts?.get('b')).toBeNull();
  });
});
