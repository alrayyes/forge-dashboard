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
    expect(compileTitleRule('.*foo.*bar').status).toBe('complex');
    expect(compileTitleRule('.*foo\\d{1,5}').status).toBe('ok');
  });

  test('long titles are cut short and each is matched once per pattern', () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      issue('a'.repeat(100000) + i),
    );
    const run = () =>
      items.filter((item) =>
        matchesFilters(item, false, {}, { hideTitleRegex: '.*a[bc]{1,9}d' }),
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
      '.*foo',
      '\\p{L}+',
    ]) {
      expect(compileTitleRule(pattern).status).toBe('ok');
    }
  });
});

// The second review (#1598): a chain of choice points multiplies, whether the
// groups are quantified or not.
describe('a chain of choice points is refused or fast', () => {
  const chain = (unit: string, n: number, tail: string) =>
    unit.repeat(n) + tail;
  const CHAINS: [string, string][] = [
    [chain('(a|a)?', 18, 'b'), 'a'.repeat(18)],
    [chain('(a|b)?', 24, 'c'), 'ab'.repeat(40)],
    [chain('(a|a)', 20, 'b'), 'a'.repeat(20)],
    [chain('a?', 25, 'b'), 'a'.repeat(25)],
    [chain('(a|a)?', 22, 'b'), 'a'.repeat(22)],
  ];

  for (const [pattern, title] of CHAINS) {
    test(`${pattern.slice(0, 30)}... is refused or fast`, () => {
      const rule = compileTitleRule(pattern);
      if (rule.status !== 'ok') return;
      const started = performance.now();
      matchesFilters(issue(title), false, {}, { hideTitleRegex: pattern });
      expect(performance.now() - started).toBeLessThan(50);
    });
  }
});

// A seeded fuzz over a small grammar: any pattern the guard accepts has to
// finish inside the budget on hostile titles. A failure prints the pattern.
describe('fuzz: whatever the guard accepts is fast', () => {
  function rng(seed: number) {
    let t = seed + 0x6d2b79f5;
    return () => {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generate(seed: number): string {
    const r = rng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const quantifier = () => {
      const x = r();
      if (x < 0.5) return '';
      return pick(['?', '*', '+', '{2}', '{3}', '{1,3}', '{2,5}', '{0,10}']);
    };
    const atom = (depth: number): string => {
      if (depth < 3 && r() < 0.35) {
        const branches = 1 + Math.floor(r() * 3);
        const parts = Array.from({ length: branches }, () =>
          sequence(depth + 1),
        );
        return `(${r() < 0.3 ? '?:' : ''}${parts.join('|')})`;
      }
      return pick(['a', 'a', 'b', '.', '[ab]', '[^a]', '\\w']);
    };
    const sequence = (depth: number): string => {
      const n = 1 + Math.floor(r() * (depth === 0 ? 6 : 3));
      let out = '';
      for (let i = 0; i < n; i++) out += atom(depth) + quantifier();
      return out;
    };
    return sequence(0).slice(0, MAX_TITLE_REGEX_LENGTH);
  }

  const HOSTILE = (() => {
    const out: string[] = [];
    for (const n of [128, 256]) {
      out.push('a'.repeat(n));
      out.push('ab'.repeat(n / 2));
      out.push(`${'a'.repeat(n - 1)}c`);
      out.push(`${'ab'.repeat(n / 2 - 1)}ac`);
    }
    return out;
  })();

  test('no accepted pattern is slow, over a few thousand seeds', () => {
    const started = performance.now();
    let accepted = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const pattern = generate(seed);
      const rule = compileTitleRule(pattern);
      if (rule.status !== 'ok') continue;
      accepted++;
      for (const title of HOSTILE) {
        // A pause from the host (GC, another process) is not a slow pattern:
        // the second timing, on a title that isn't cached, has to be slow too.
        let took = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          compileTitleRule(pattern);
          const t0 = performance.now();
          matchesFilters(
            issue(attempt === 0 ? title : `${title.slice(0, -1)}d`),
            false,
            {},
            {
              hideTitleRegex: pattern,
            },
          );
          took = performance.now() - t0;
          if (took < 50) break;
        }
        if (took >= 50) {
          throw new Error(
            `accepted pattern took ${took.toFixed(0)} ms: ${pattern} on ${title.slice(0, 20)}... (seed ${seed})`,
          );
        }
      }
    }
    // The generator has to exercise the guard, not be refused wholesale.
    expect(accepted).toBeGreaterThan(300);
    expect(performance.now() - started).toBeLessThan(5000);
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
