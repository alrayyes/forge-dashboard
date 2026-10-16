/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  applyServerState,
  compileTitleRule,
  type FilterableItem,
  failingFilters,
  MAX_TITLE_REGEX_LENGTH,
  matchesFilters,
  optionPool,
  type SharedFilterState,
} from './filters';

// #1593: "Hide titles matching (regex)" on the Issues page. Pure, so these run
// without a browser; the page wiring is in issue-hide-title-regex.spec.ts.

function issue(title: string, overrides: Partial<FilterableItem> = {}) {
  const now = new Date().toISOString();
  return {
    forge: 'github',
    repo: 'a/one',
    title,
    author: 'ryan',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as FilterableItem;
}

const hides = (title: string, pattern: string) =>
  !matchesFilters(issue(title), false, {}, { hideTitleRegex: pattern });

describe('compileTitleRule', () => {
  test('an empty or missing pattern is no rule', () => {
    expect(compileTitleRule('').status).toBe('none');
    expect(compileTitleRule(undefined).status).toBe('none');
  });

  test('a saved value that is not a string reads as empty', () => {
    expect(compileTitleRule(42).status).toBe('none');
    expect(compileTitleRule({ a: 1 }).status).toBe('none');
    expect(compileTitleRule(null).status).toBe('none');
  });

  test('a pattern the engine cannot parse is invalid, without throwing', () => {
    expect(compileTitleRule('(unclosed').status).toBe('invalid');
    expect(compileTitleRule('[').status).toBe('invalid');
    expect(compileTitleRule('*oops').status).toBe('invalid');
  });

  test('a pattern over the length cap is too complex', () => {
    expect(compileTitleRule('a'.repeat(MAX_TITLE_REGEX_LENGTH)).status).toBe(
      'ok',
    );
    expect(
      compileTitleRule('a'.repeat(MAX_TITLE_REGEX_LENGTH + 1)).status,
    ).toBe('complex');
  });
});

describe('hiding by title', () => {
  test('hides a title that matches, case-insensitively', () => {
    expect(hides('Weekly report for May', '^weekly report')).toBe(true);
    expect(hides('WEEKLY REPORT', '^Weekly report')).toBe(true);
  });

  test('matches anywhere in the title', () => {
    expect(hides('Please check the weekly report', 'weekly report')).toBe(true);
    expect(hides('Something else', 'weekly report')).toBe(false);
  });

  test('anchors are honoured', () => {
    expect(hides('The Weekly report', '^Weekly report')).toBe(false);
  });

  test('an empty pattern hides nothing', () => {
    expect(hides('Anything', '')).toBe(false);
  });

  test('an invalid pattern hides nothing', () => {
    expect(hides('Anything (', '(')).toBe(false);
  });

  test('says which filter hid it', () => {
    expect(
      failingFilters(
        issue('Weekly report'),
        false,
        {},
        {
          hideTitleRegex: '^Weekly',
        },
      ),
    ).toEqual(['hideTitleRegex']);
  });

  test('applies only to issues', () => {
    expect(
      matchesFilters(
        issue('Weekly report'),
        true,
        {},
        {
          hideTitleRegex: '^Weekly',
        },
      ),
    ).toBe(true);
  });

  test('drops a repo from the choices when its only issue is hidden', () => {
    const items = [
      issue('Fix a bug', { repo: 'a/real' }),
      issue('Weekly report', { repo: 'a/reports' }),
    ];
    const repos = (extra: Record<string, string>) =>
      optionPool(items, false, {}, '', extra).map((i) => i.repo);

    expect(repos({ hideTitleRegex: '^Weekly' })).toEqual(['a/real']);
    expect(repos({ hideTitleRegex: '' })).toEqual(['a/real', 'a/reports']);
  });
});

describe('a pathological pattern cannot freeze the page', () => {
  const title = `${'a'.repeat(40)}b`;

  test('nested quantifiers are refused as too complex', () => {
    for (const pattern of [
      '(a+)+$',
      '(a*)*$',
      '(a|aa)+$',
      '(.*a){5,}',
      '((a+))+',
    ]) {
      expect(compileTitleRule(pattern).status).toBe('complex');
    }
  });

  test('(a+)+$ against a long title returns at once and hides nothing', () => {
    const started = performance.now();
    const hidden = !matchesFilters(
      issue(title),
      false,
      {},
      {
        hideTitleRegex: '(a+)+$',
      },
    );
    expect(hidden).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test('a safe quantified group still works', () => {
    expect(hides('Weekly report 12', '^(Weekly|Monthly) report')).toBe(true);
    expect(hides('abab', '^(ab)+$')).toBe(true);
    expect(hides('x1', '[0-9]+')).toBe(true);
    expect(hides('a\\+b', 'a\\\\\\+b')).toBe(true);
  });

  test('too many open-ended repeats are refused', () => {
    expect(compileTitleRule('.*.*.*b').status).toBe('complex');
    expect(compileTitleRule('.*foo.*bar').status).toBe('ok');
  });

  test('long titles are cut short and each is matched once per pattern', () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      issue('a'.repeat(100000) + i),
    );
    const run = () =>
      items.filter((item) =>
        matchesFilters(item, false, {}, { hideTitleRegex: '.*a.*b' }),
      );

    const first = performance.now();
    expect(run()).toHaveLength(100);
    expect(performance.now() - first).toBeLessThan(3000);

    const again = performance.now();
    run();
    expect(performance.now() - again).toBeLessThan(20);
  });
});

// The reviewer's corpus (#1598): each pattern is refused as too complex, or it
// finishes inside the budget on a 256-character title built to hurt it.
describe('the guard is sound for a corpus of slow patterns', () => {
  const a = (n: number, tail: string) => 'a'.repeat(n) + tail;
  const CORPUS: [string, string][] = [
    ['(a+){5}$', a(255, 'b')],
    ['(a+){6}$', a(255, 'b')],
    ['(a*){5}$', a(255, 'b')],
    ['(a*){3}b', a(255, '')],
    ['((a?){20}){20}b', a(100, 'c')],
    ['(a+)+$', a(255, 'b')],
    ['(a|a)*b', a(255, '')],
    ['(a*)*', a(255, 'b')],
    ['(x+x+)+y', 'x'.repeat(255)],
    ['^(([a-z])+.)+[A-Z]([a-z])+$', a(255, '!')],
    ['(?:a+){10}$', a(255, 'b')],
    ['(a{1,10}){1,10}b', a(255, '')],
    ['a{1,50}a{1,50}a{1,50}b', a(255, '')],
    ['(a+)\\1+$', a(255, 'b')],
    ['(?=(a+)+)b', a(255, 'b')],
    ['(?:(a+)(?=b)){4}c', a(255, 'b')],
    ['.*.*.*b', a(255, '')],
    ['(?<n>a+){4}\\k<n>$', a(255, 'b')],
  ];

  for (const [pattern, title] of CORPUS) {
    test(`${pattern} is refused or fast`, () => {
      const started = performance.now();
      const rule = compileTitleRule(pattern);
      if (rule.status === 'ok') {
        matchesFilters(issue(title), false, {}, { hideTitleRegex: pattern });
      }
      expect(
        rule.status === 'complex' || performance.now() - started < 50,
      ).toBe(true);
    });
  }

  test('a valid pattern the guard refuses is "complex", not "invalid"', () => {
    expect(compileTitleRule('(a+)+$').status).toBe('complex');
    expect(compileTitleRule('(').status).toBe('invalid');
    expect(compileTitleRule('a'.repeat(201)).status).toBe('complex');
  });

  test('everyday patterns still pass', () => {
    for (const pattern of [
      '^Weekly report',
      '^(Weekly|Monthly) report',
      '\\bfoo\\b',
      '^(ab)+$',
      '(?<=x)y',
      '^Release v\\d{1,3}\\.\\d{1,3}$',
      '(Weekly )?report',
      '.*foo.*bar',
      '\\p{L}+',
    ]) {
      expect(compileTitleRule(pattern).status).toBe('ok');
    }
  });
});

describe('saved state', () => {
  const blank = (): SharedFilterState => ({
    shared: {},
    pr: {},
    issue: { hideDependencyDashboard: '1' },
    view: {},
  });

  test('keeps a saved pattern', () => {
    const state = blank();
    applyServerState(state, { issue: { hideTitleRegex: '^Weekly' } });
    expect(state.issue.hideTitleRegex).toBe('^Weekly');
  });

  test('a saved non-string value is dropped, so it reads as empty', () => {
    const state = blank();
    applyServerState(state, {
      issue: { hideTitleRegex: 7 as unknown as string },
    });
    expect(state.issue.hideTitleRegex).toBeUndefined();
  });
});
