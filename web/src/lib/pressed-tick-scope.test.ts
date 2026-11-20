/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The overview's pressed pill draws a tick so the pick never rests on colour
// alone. A CI filter pill carries its pick in the glyph and the ring instead,
// so the tick rule leaves it out by its own selector, not by a second rule that
// cancels it (#4300).

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

// The e2e journey also guards this in a browser, but only for the pills it
// visits. This test reads the stylesheet, so a tick drawn under any class is
// caught without one.

// The attribute in any spelling: spaces inside the brackets, any case, `~=`,
// an `i` flag, or bare presence.
const pressed = /\[\s*aria-pressed\s*(?:~?=\s*(["']?)true\1\s*[is]?\s*)?\]/i;
// A pseudo-element in any case, optionally followed by pseudo-classes. The
// pseudo-classes are peeled off the end one at a time, so an argument may
// nest parentheses to any depth (`:not(:is(.a))`).
function endsInPseudoElement(selector: string): boolean {
  let rest = selector;
  for (;;) {
    if (rest.endsWith(')')) {
      let depth = 0;
      let open = -1;
      for (let i = rest.length - 1; i >= 0; i--) {
        if (rest[i] === ')') depth++;
        else if (rest[i] === '(' && --depth === 0) {
          open = i;
          break;
        }
      }
      if (open < 0) return false;
      rest = rest.slice(0, open);
    }
    const pseudoClass = /:[\w-]+$/.exec(rest);
    if (!pseudoClass || /^:(before|after)$/i.test(pseudoClass[0])) break;
    rest = rest.slice(0, pseudoClass.index);
  }

  return /::?(before|after)$/i.test(rest);
}

// Split a selector list on its top-level commas, so a comma inside :is(),
// :where(), :not() or an attribute value stays in one selector.
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));

  return parts;
}

// Every selector in the stylesheet that draws a pressed element's ::before or
// ::after, under any class.
function tickSelectors(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = splitSelectors(
      m[1]
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')'),
    ).map((part) => part.trim());
    for (const selector of selectors) {
      if (pressed.test(selector) && endsInPseudoElement(selector)) {
        found.push(selector);
      }
    }
  }

  return found;
}

describe('The pressed pill tick', () => {
  test('is found under any class, quoting or pseudo-element spelling', () => {
    const sample = [
      '.a[aria-pressed="true"]::before { content: "x"; }',
      ".b[aria-pressed='true']::after { content: 'x'; }",
      '.c[aria-pressed=true]:before { content: "x"; }',
      '.d[aria-pressed="true"], .e[aria-pressed="false"]::before { x: y; }',
      '.f[aria-pressed="true"] { color: red; }',
    ].join('\n');
    expect(tickSelectors(sample)).toEqual([
      '.a[aria-pressed="true"]::before',
      ".b[aria-pressed='true']::after",
      '.c[aria-pressed=true]:before',
    ]);
  });

  test('keeps a comma inside :is(), :where() and :not() in one selector', () => {
    const sample = [
      '[aria-pressed="true"]:is(.a, .b)::before { x: y; }',
      '.c:where(.d, .e)[aria-pressed="true"]::after { x: y; }',
      '.f:not(.g, .h)[aria-pressed="true"]::before, .i { x: y; }',
    ].join('\n');
    expect(tickSelectors(sample)).toEqual([
      '[aria-pressed="true"]:is(.a, .b)::before',
      '.c:where(.d, .e)[aria-pressed="true"]::after',
      '.f:not(.g, .h)[aria-pressed="true"]::before',
    ]);
  });

  test('keeps a comma inside a quoted attribute value in one selector', () => {
    const double = '.a[data-x="a,b"][aria-pressed="true"]::before';
    const single = ".c[data-x='a,b'][aria-pressed='true']::after";
    const sample = `${double}, .d { x: y; }\n${single} { x: y; }`;
    expect(tickSelectors(sample)).toEqual([double, single]);
  });

  test('ignores a bracket inside a quoted attribute value', () => {
    // The `]` would close the bracket early, and the comma after it would
    // split the selector, if the quote did not hide it.
    const closing = '.a[data-x="]x,y"][aria-pressed="true"]::before';
    const opening = ".b[data-x='[x,y'][aria-pressed='true']::after";
    const sample = `${closing} { x: y; }\n${opening} { x: y; }`;
    expect(tickSelectors(sample)).toEqual([closing, opening]);
  });

  test('does not end a quote on the other quote character', () => {
    const selector = `.a[data-x="it's, odd"][aria-pressed="true"]::before`;
    expect(tickSelectors(`${selector}, .b { x: y; }`)).toEqual([selector]);
  });

  test('splits after a closed attribute bracket', () => {
    const sample = '.a[x], .b[aria-pressed="true"]::before { x: y; }';
    expect(tickSelectors(sample)).toEqual(['.b[aria-pressed="true"]::before']);
  });

  test('keeps a comma inside an unquoted attribute bracket in one selector', () => {
    const selector = '.a[data-x=a,b][aria-pressed="true"]::before';
    expect(tickSelectors(`${selector} { x: y; }`)).toEqual([selector]);
  });

  test('splits after a closed parenthesis', () => {
    const sample = '.a:not(.b), .c[aria-pressed="true"]::before { x: y; }';
    expect(tickSelectors(sample)).toEqual(['.c[aria-pressed="true"]::before']);
  });

  test('finds a pseudo-element followed by a pseudo-class with an argument', () => {
    const selector = '.a[aria-pressed="true"]::before:not(.b)';
    expect(tickSelectors(`${selector} { x: y; }`)).toEqual([selector]);
  });

  test('finds a pseudo-element followed by a pseudo-class with nested parentheses', () => {
    const selector = '.a[aria-pressed="true"]::before:not(:is(.b))';
    expect(tickSelectors(`${selector} { x: y; }`)).toEqual([selector]);
  });

  const spellings = [
    '[aria-pressed="true" i]',
    '[aria-pressed = "true"]',
    '[ aria-pressed="true" ]',
    '[ARIA-PRESSED="true"]',
    '[aria-pressed="TRUE"]',
    '[aria-pressed]',
    '[aria-pressed~="true"]',
  ];
  for (const spelling of spellings) {
    test(`finds the attribute spelled ${spelling}`, () => {
      const selector = `.a${spelling}::before`;
      expect(tickSelectors(`${selector} { x: y; }`)).toEqual([selector]);
    });
  }

  test('leaves a pill that is not pressed alone', () => {
    const sample = '.a[aria-pressed="false"]::before { x: y; }';
    expect(tickSelectors(sample)).toEqual([]);
  });

  test('finds ::BEFORE in capitals', () => {
    const selector = '.a[aria-pressed="true"]::BEFORE';
    expect(tickSelectors(`${selector} { x: y; }`)).toEqual([selector]);
  });

  test('finds a pseudo-element followed by a pseudo-class', () => {
    const selector = '.a[aria-pressed="true"]::before:hover';
    expect(tickSelectors(`${selector} { x: y; }`)).toEqual([selector]);
  });

  test('is drawn only on the quick pill', () => {
    const others = tickSelectors(css).filter((s) => !s.includes('.quick-pill'));
    expect(others).toEqual([]);
  });

  test('is scoped away from the CI filter pill by its own selector', () => {
    const ticks = tickSelectors(css).filter((s) => s.includes('.quick-pill'));
    expect(ticks.length).toBeGreaterThan(0);
    for (const selector of ticks) {
      expect(selector).toContain(':not(.ci-filter-pill)');
    }
  });

  test('leaves no rule that cancels the tick on a CI filter pill', () => {
    const cancels = tickSelectors(css).filter(
      (s) =>
        s.includes('.ci-filter-pill') && !s.includes(':not(.ci-filter-pill)'),
    );
    expect(cancels).toEqual([]);
  });
});
