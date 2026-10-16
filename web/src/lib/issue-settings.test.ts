/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  addIgnoredTitle,
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
