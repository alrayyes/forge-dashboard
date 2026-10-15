/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The nav pill's count colours against the pill's own background, in both
// themes, read straight from the stylesheet. axe-core can't carry this check:
// for text it can't be sure is real text (a single digit, which is every
// count under ten) or a ratio of exactly 1:1, its color-contrast rule files
// the node as "incomplete", never as a violation, so a failing pill with
// `color: #ff0` passed every axe journey.
// https://github.com/alrayyes/forge-dashboard/issues/1527
//
// 4.5:1 is WCAG 2.2 success criterion 1.4.3 for text: the pill's 10 to 11px
// numbers are not "large text" (18.66px bold or more).
// https://www.w3.org/TR/WCAG22/#contrast-minimum
// The glyph beside each number is drawn in the same colour. It only needs 3:1
// (1.4.11, https://www.w3.org/TR/WCAG22/#non-text-contrast), so the text
// threshold covers it.

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

// The text between the braces of the first block whose selector starts at
// `selector`, with nested blocks kept.
function block(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} in style.css`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unclosed ${selector}`);
}

function tokens(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    found.set(m[1], m[2].trim());
  }
  return found;
}

const light = tokens(block(css, ':root {'));
const darkTokens = {
  'prefers-color-scheme: dark': tokens(
    block(
      block(css, '@media (prefers-color-scheme: dark)'),
      ':root:not([data-theme="light"])',
    ),
  ),
  'data-theme=dark': tokens(block(css, ':root[data-theme="dark"]')),
};
const themes: [string, Map<string, string>][] = [
  ['light', light],
  ...Object.entries(darkTokens).map(
    ([name, dark]) =>
      [name, new Map([...light, ...dark])] as [string, Map<string, string>],
  ),
];

function resolve(value: string, theme: Map<string, string>): string {
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (!ref) return value;
  const next = theme.get(ref[1]);
  if (!next) throw new Error(`${ref[1]} is not defined`);
  return resolve(next, theme);
}

function channel(hex: string): [number, number, number] {
  const full = hex.replace('#', '');
  const digits =
    full.length === 3 ? [...full].map((c) => c + c).join('') : full;
  if (!/^[0-9a-f]{6}$/i.test(digits))
    throw new Error(`not a hex colour: ${hex}`);
  const n = Number.parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
function luminance(hex: string): number {
  const [r, g, b] = channel(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const KNOWN = ['total', 'failed', 'running', 'passed'];
const PILL_SELECTOR = /\.nav-(?:pills|total|failed|running|passed|none)\b/;

type Rule = { selectors: string[]; body: string };

// Every innermost `selectors { declarations }` rule, media queries included.
function rules(source: string): Rule[] {
  const out: Rule[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((x) => x.trim());
    out.push({ selectors, body: m[2] });
  }
  return out;
}

const declared = (body: string, prop: string) =>
  body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+?)\\s*(?:;|$)`))?.[1];

// The pills, found from the stylesheet: each `.nav-<word> { color }` rule, the
// first one wins. Anything that could change what the test measures without
// being measured is a problem, so the next editor extends the test.
function pillColours(source: string): {
  colours: Map<string, string>;
  problems: string[];
} {
  const colours = new Map<string, string>();
  const problems: string[] = [];
  for (const { selectors, body } of rules(source)) {
    const touches = selectors.filter((sel) => PILL_SELECTOR.test(sel));
    if (touches.length === 0) continue;
    const color = declared(body, 'color');
    const exact = touches.find((sel) => /^\.nav-(?!pills\b)[a-z]+$/.test(sel));
    if (color && exact && !colours.has(exact)) {
      colours.set(exact, color);
    } else if (color) {
      problems.push(`${touches.join(', ')} sets color`);
    }
    if (declared(body, 'opacity')) {
      problems.push(`${touches.join(', ')} sets opacity`);
    }
    if (
      declared(body, 'background') !== undefined &&
      touches.some((sel) => sel !== '.nav-pills')
    ) {
      problems.push(`${touches.join(', ')} sets a background`);
    }
  }
  if (!KNOWN.every((w) => colours.has(`.nav-${w}`))) {
    problems.push(
      `found only ${[...colours.keys()].join(', ')}; expected at least ${KNOWN.map((w) => `.nav-${w}`).join(', ')}`,
    );
  }
  return { colours, problems };
}

const MESSAGE =
  'Extend nav-pill-contrast.test.ts to measure this before changing the pill: ';

// Ratios below 4.5:1 for the pills of a stylesheet, per theme.
function failures(source: string, theme: Map<string, string>): string[] {
  const { colours } = pillColours(source);
  const bg = resolve('var(--surface-sunken)', theme);
  return [...colours].flatMap(([sel, value]) => {
    const r = ratio(resolve(value, theme), bg);
    return r >= 4.5 ? [] : [`${sel} is ${r.toFixed(2)}:1`];
  });
}

const background = block(css, '.nav-pills {')
  .match(/background:\s*([^;]+);/)?.[1]
  ?.trim();

describe('nav pill colours', () => {
  test('the pill draws its own background', () => {
    // --surface-sunken is the token that matters: the pill paints it over the
    // header and the tab bar, so the page's --surface never sits behind a count.
    expect(background).toBe('var(--surface-sunken)');
  });

  test('nothing else changes a pill colour, opacity or background', () => {
    const { problems } = pillColours(css);
    if (problems.length > 0) throw new Error(MESSAGE + problems.join('; '));
  });

  test('finds the pills from the stylesheet', () => {
    const { colours } = pillColours(css);
    for (const w of KNOWN) expect(colours.has(`.nav-${w}`)).toBe(true);
  });

  for (const [name, theme] of themes) {
    test(`every pill reads at 4.5:1 on the pill in the ${name} theme`, () => {
      expect(failures(css, theme)).toEqual([]);
    });
  }
});

describe('pillColours on a synthetic stylesheet', () => {
  const base = `.nav-total { color: var(--ink); }
.nav-failed { color: var(--critical); }
.nav-running { color: var(--warning); }
.nav-passed { color: var(--good); }`;

  test('checks a pill it was not told about', () => {
    const sheet = `${base}\n.nav-none { color: #ff0; }`;
    expect(pillColours(sheet).colours.has('.nav-none')).toBe(true);
    expect(failures(sheet, light)).toEqual(['.nav-none is 1.00:1']);
  });

  test('fails loudly when a known pill is missing', () => {
    expect(pillColours('.nav-failed { color: red; }').problems.length).toBe(1);
  });

  test('flags a later override, an opacity and a stacked background', () => {
    expect(
      pillColours(`${base}\n.nav-pills .nav-failed { color: #ff0; }`).problems,
    ).toHaveLength(1);
    expect(
      pillColours(`${base}\n.nav-failed { opacity: 0.5; }`).problems,
    ).toHaveLength(1);
    expect(
      pillColours(`${base}\n.nav-pills.stacked { background: #fff; }`).problems,
    ).toHaveLength(1);
  });
});
