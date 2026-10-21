/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type ClosingIssue,
  closingPillName,
  closingPillText,
  findAddressedIssue,
  missingIssueNote,
  parseIssueAddress,
  splitClosing,
} from './closing-issues';

// The pull request row's pills and the address that opens an issue's pop-up.
// The server decides which issues a pull request closes and builds each
// address, so this only words and reads them. The page wiring is
// closing-issues.spec.ts.

const issue = (overrides: Partial<ClosingIssue> = {}): ClosingIssue => ({
  repo: 'alrayyes/app',
  number: 12,
  url: 'https://github.com/alrayyes/app/issues/12',
  pageUrl: '/issues.html?issue=github/alrayyes/app/12',
  ...overrides,
});

describe('closingPillText', () => {
  test('is the bare number for the pull request own repo, ignoring case', () => {
    expect(closingPillText(issue(), 'alrayyes/app')).toBe('Closes #12');
    expect(closingPillText(issue(), 'Alrayyes/App')).toBe('Closes #12');
  });

  test('names the repo when the issue is in another one', () => {
    expect(
      closingPillText(issue({ repo: 'alrayyes/lib' }), 'alrayyes/app'),
    ).toBe('Closes alrayyes/lib#12');
  });
});

describe('closingPillName', () => {
  test('contains the visible text (WCAG 2.5.3)', () => {
    const text = closingPillText(issue(), 'alrayyes/app');
    expect(closingPillName(issue(), 'alrayyes/app')).toContain(text);
  });
});

describe('splitClosing', () => {
  test('shows two and keeps the rest behind the count', () => {
    const list = [1, 2, 3, 4].map((number) => issue({ number }));
    const { shown, rest } = splitClosing(list);
    expect(shown.map((i) => i.number)).toEqual([1, 2]);
    expect(rest.map((i) => i.number)).toEqual([3, 4]);
  });
});

describe('parseIssueAddress', () => {
  test('reads the form the server writes', () => {
    expect(parseIssueAddress('?issue=github/alrayyes/app/12')).toEqual({
      forge: 'github',
      repo: 'alrayyes/app',
      number: 12,
    });
    expect(parseIssueAddress('?issue=forgejo/Ryan/Hush/3')?.forge).toBe(
      'forgejo',
    );
  });

  test.each([
    '',
    '?issue=',
    '?issue=github/alrayyes/app',
    '?issue=gitlab/alrayyes/app/12',
    '?issue=github/alrayyes/app/x',
    '?issue=github/alrayyes/app/12abc',
    '?issue=github/alrayyes/app/-1',
    '?issue=github/alrayyes/app/1.5',
    '?issue=github/alrayyes/app/12/extra',
    '?issue=github/alrayyes/app/sub/12',
    '?issue=evil/alrayyes/app/12',
    '?issue=GitHub/alrayyes/app/12',
    '?issue=github/alrayyes/app/0',
    '?issue=github//app/12',
    '?pr=github/alrayyes/app/12',
  ])('opens nothing for %p', (search) => {
    expect(parseIssueAddress(search)).toBeNull();
  });
});

describe('findAddressedIssue', () => {
  const listed = [
    { forge: 'forgejo', repo: 'Ryan/Hush', number: 3 },
    { forge: 'github', repo: 'alrayyes/app', number: 3 },
    { forge: 'github', repo: 'alrayyes/app', number: 12 },
  ];

  test('matches the repo ignoring case, as Forgejo lowercases closing references', () => {
    expect(
      findAddressedIssue(listed, {
        forge: 'forgejo',
        repo: 'ryan/hush',
        number: 3,
      }),
    ).toBe(listed[0]);
  });

  test('needs the same forge and number', () => {
    expect(
      findAddressedIssue(listed, {
        forge: 'github',
        repo: 'ryan/hush',
        number: 3,
      }),
    ).toBeUndefined();
    expect(
      findAddressedIssue(listed, {
        forge: 'github',
        repo: 'alrayyes/app',
        number: 99,
      }),
    ).toBeUndefined();
  });
});

describe('missingIssueNote', () => {
  test('names the issue and the reasons it may be absent', () => {
    const note = missingIssueNote({
      forge: 'github',
      repo: 'alrayyes/app',
      number: 12,
    });
    expect(note).toContain('alrayyes/app #12');
    expect(note).toContain('not open any more');
  });
});
