/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { tokenizeRegex } from './regex-tokens';

// Splits an RE2 pattern into display tokens for the Ignored issue titles list
// (#4852). It classifies characters for colouring and never matches, so the
// tokens must always join back to the exact input.
const kinds = (p: string) => tokenizeRegex(p).map((t) => [t.kind, t.text]);
const joined = (p: string) =>
  tokenizeRegex(p)
    .map((t) => t.text)
    .join('');

describe('tokenizeRegex', () => {
  test('an empty pattern has no tokens', () => {
    expect(tokenizeRegex('')).toEqual([]);
  });

  test('plain text is one literal token', () => {
    expect(kinds('Weekly report')).toEqual([['literal', 'Weekly report']]);
  });

  test('anchors', () => {
    expect(kinds('^a$')).toEqual([
      ['anchor', '^'],
      ['literal', 'a'],
      ['anchor', '$'],
    ]);
  });

  test('word boundary and text anchors are anchors, not escapes', () => {
    expect(kinds('\\bx\\z')).toEqual([
      ['anchor', '\\b'],
      ['literal', 'x'],
      ['anchor', '\\z'],
    ]);
  });

  test('an escaped metacharacter is one escape token', () => {
    expect(kinds('a\\(web\\)$')).toEqual([
      ['literal', 'a'],
      ['escape', '\\('],
      ['literal', 'web'],
      ['escape', '\\)'],
      ['anchor', '$'],
    ]);
  });

  test('an escaped backslash does not escape the next character', () => {
    expect(kinds('\\\\(')).toEqual([
      ['escape', '\\\\'],
      ['group', '('],
    ]);
  });

  test('class escapes, unicode classes and hex escapes', () => {
    expect(kinds('\\d\\pL\\p{Greek}\\x41\\x{1F600}')).toEqual([
      ['escape', '\\d'],
      ['escape', '\\pL'],
      ['escape', '\\p{Greek}'],
      ['escape', '\\x41'],
      ['escape', '\\x{1F600}'],
    ]);
  });

  test('groups and alternation, nested', () => {
    expect(kinds('(a|(b))')).toEqual([
      ['group', '('],
      ['literal', 'a'],
      ['group', '|'],
      ['group', '('],
      ['literal', 'b'],
      ['group', ')'],
      ['group', ')'],
    ]);
  });

  test('group flags and names stay with the opening bracket', () => {
    expect(kinds('(?:a)(?i)(?P<n>b)')).toEqual([
      ['group', '(?:'],
      ['literal', 'a'],
      ['group', ')'],
      ['group', '(?i)'],
      ['group', '(?P<n>'],
      ['literal', 'b'],
      ['group', ')'],
    ]);
  });

  test('a character class is one token', () => {
    expect(kinds('[a-z0-9]+')).toEqual([
      ['class', '[a-z0-9]'],
      ['quantifier', '+'],
    ]);
  });

  test('a negated class and a leading ] are part of the class', () => {
    expect(kinds('[^]a]x')).toEqual([
      ['class', '[^]a]'],
      ['literal', 'x'],
    ]);
    expect(kinds('[]a]')).toEqual([['class', '[]a]']]);
  });

  test('an escaped ] does not close the class', () => {
    expect(kinds('[a\\]b]c')).toEqual([
      ['class', '[a\\]b]'],
      ['literal', 'c'],
    ]);
  });

  test('a POSIX class inside a class does not close it', () => {
    expect(kinds('[[:alpha:]_]z')).toEqual([
      ['class', '[[:alpha:]_]'],
      ['literal', 'z'],
    ]);
  });

  test('quantifiers, with and without the lazy mark', () => {
    expect(kinds('a*b+c?d{2}e{2,}f{2,5}g+?')).toEqual([
      ['literal', 'a'],
      ['quantifier', '*'],
      ['literal', 'b'],
      ['quantifier', '+'],
      ['literal', 'c'],
      ['quantifier', '?'],
      ['literal', 'd'],
      ['quantifier', '{2}'],
      ['literal', 'e'],
      ['quantifier', '{2,}'],
      ['literal', 'f'],
      ['quantifier', '{2,5}'],
      ['literal', 'g'],
      ['quantifier', '+?'],
    ]);
  });

  test('a brace that is not a repeat is literal text', () => {
    expect(kinds('a{b}{,3}')).toEqual([['literal', 'a{b}{,3}']]);
  });

  test('a dot is drawn as a class', () => {
    expect(kinds('a.b')).toEqual([
      ['literal', 'a'],
      ['class', '.'],
      ['literal', 'b'],
    ]);
  });

  test('an unterminated class falls back to literal text for the rest', () => {
    expect(kinds('^a[bc(d')).toEqual([
      ['anchor', '^'],
      ['literal', 'a[bc(d'],
    ]);
  });

  test('a trailing backslash is literal and does not throw', () => {
    expect(kinds('a\\')).toEqual([['literal', 'a\\']]);
  });

  test('unbalanced brackets do not throw', () => {
    expect(joined('((a')).toBe('((a');
    expect(joined('a))')).toBe('a))');
  });

  test('the tokens always join back to the exact pattern', () => {
    const patterns = [
      '^Dependency advisories$',
      'Dependency advisories \\(web\\)$',
      '(?i)^\\[bot\\] [a-z]+{2,3}|x\\',
      '[a\\]',
      '[[:alpha:]',
      '{{}}\\x{',
      '\\p{',
      'é\u{1F600}[ü]',
    ];
    for (const p of patterns) expect(joined(p)).toBe(p);
  });

  test('never yields an empty token, and merges adjacent literals', () => {
    for (const t of tokenizeRegex('ab}c{d')) expect(t.text).not.toBe('');
    expect(tokenizeRegex('ab}c{d')).toHaveLength(1);
  });
});
