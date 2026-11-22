/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The overview's pressed pill once drew a tick so the pick never rested on
// colour alone; a CI filter pill carried its pick in the glyph and the ring, so
// the tick rule left it out by its own selector (#4300). The shared filter pill
// replaced both: no pressed pill draws a tick now (#4611), and a stylesheet rule
// that brings one back has to say why here.

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

// The e2e journey also guards this in a browser, but only for the pills it
// visits. This test reads the stylesheet, so a tick drawn under any class is
// caught without one.

// Undo CSS escapes, so `tr\75 e` reads as `true`. A hex escape takes up to six
// digits and one optional space after them, which is why `\75e` is U+075E and
// not `ue`. Any other escaped character stands for itself.
function unescapeCss(value: string): string {
  return value.replace(
    /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([\s\S]))/gi,
    (_, hex: string | undefined, plain: string | undefined) =>
      hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : (plain ?? ''),
  );
}

// The attribute in any spelling: spaces inside the brackets, any case, an
// `i` flag, bare presence, and every operator (`=`, `~=`, `|=`, `^=`, `$=`,
// `*=`) with a quoted, unquoted or escaped value.
const attribute =
  /\[\s*aria-pressed\s*(?:([~|^$*]?)=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"']*))\s*[is]?\s*)?\]/gi;

// Whether the operator can match the value `true`, the one pressed state.
function matchesTrue(operator: string, value: string): boolean {
  const wanted = value.toLowerCase();
  switch (operator) {
    case '^':
      return wanted !== '' && 'true'.startsWith(wanted);
    case '$':
      return wanted !== '' && 'true'.endsWith(wanted);
    case '*':
      return wanted !== '' && 'true'.includes(wanted);
    default:
      // `=`, `~=` and `|=` all match the whole word `true` and nothing less.
      return wanted === 'true';
  }
}

function isPressed(selector: string): boolean {
  for (const m of unescapeCss(selector).matchAll(attribute)) {
    const value = m[2] ?? m[3] ?? m[4];
    if (value === undefined || matchesTrue(m[1], value)) return true;
  }

  return false;
}

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
      if (isPressed(selector) && endsInPseudoElement(selector)) {
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
    '[aria-pressed|="true"]',
    '[aria-pressed^="tr"]',
    '[aria-pressed$="ue"]',
    '[aria-pressed*="ru"]',
    '[aria-pressed*=ru]',
    '[aria-pressed=true i]',
    '[aria-pressed=tr\\75 e]',
    '[aria-pressed="tr\\75 e"]',
    '[aria-pressed="tr\\000075e"]',
    '[aria-pressed="\\t\\rue"]',
    '[aria-pressed="\\74 rue"]',
    '[aria-pressed="\\74rue"]',
    '[aria-\\70ressed="true"]',
  ];
  for (const spelling of spellings) {
    test(`finds the attribute spelled ${spelling}`, () => {
      const selector = `.a${spelling}::before`;
      expect(tickSelectors(`${selector} { x: y; }`)).toEqual([selector]);
    });
  }

  // An operator that cannot match the value `true` is not a pressed tick.
  const notPressed = [
    '[aria-pressed="false"]',
    '[aria-pressed="mixed"]',
    '[aria-pressed^="ru"]',
    '[aria-pressed$="tr"]',
    '[aria-pressed*="xyz"]',
    '[aria-pressed=]',
    '[aria-pressed^=]',
    '[aria-pressed^=""]',
    '[aria-pressed$=""]',
    '[aria-pressed*=""]',
    '[aria-pressed|="tr"]',
    '[aria-pressed~="tr"]',
    // `\75e` is one escape for U+075E, not `u` then `e`.
    '[aria-pressed="tr\\75e"]',
    '[aria-pressed="\\66 alse"]',
  ];
  for (const spelling of notPressed) {
    test(`leaves the attribute spelled ${spelling} alone`, () => {
      expect(tickSelectors(`.a${spelling}::before { x: y; }`)).toEqual([]);
    });
  }

  test('does not find a selector with an unbalanced closing parenthesis', () => {
    const selector = '.a[aria-pressed="true"]::before:hover)';
    expect(tickSelectors(`${selector} { x: y; }`)).toEqual([]);
  });

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

  // The pull request pills left their check mark for the shared pill's fill,
  // which is the one pressed mark every page now draws (#4611); a CI pill's
  // glyph and ring carry its own.
  test('is drawn on no pill: the fill and the forced-colours border mark a press', () => {
    expect(tickSelectors(css)).toEqual([]);
  });
});
