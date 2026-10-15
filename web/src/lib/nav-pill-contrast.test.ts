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

// The `color` a rule sets, as written in the stylesheet.
function colorOf(selector: string): string {
  const m = block(css, `${selector} {`).match(/(?:^|[\s;])color:\s*([^;]+);/);
  if (!m) throw new Error(`${selector} sets no color`);
  return m[1].trim();
}

const background = block(css, '.nav-pills {')
  .match(/background:\s*([^;]+);/)?.[1]
  ?.trim();

const PILLS = ['.nav-total', '.nav-failed', '.nav-running', '.nav-passed'];

describe('nav pill colours', () => {
  test('the pill draws its own background', () => {
    expect(background).toBe('var(--surface-sunken)');
  });

  for (const [name, theme] of themes) {
    for (const selector of PILLS) {
      test(`${selector} reads at 4.5:1 on the pill in the ${name} theme`, () => {
        const fg = resolve(colorOf(selector), theme);
        const bg = resolve(background ?? '', theme);
        expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
