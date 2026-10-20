/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The Running pill's counts against the pill's own background, in both themes,
// read straight from the stylesheet. axe-core files these as "incomplete", never
// as a violation (a single digit can't be told from decoration), so a pill
// with an unreadable colour passes every axe journey; the ratio is measured
// here instead, the way the menu pills' is (nav-pill-contrast.test.ts, #1527).
// 4.5:1 is WCAG 1.4.3 for text of this size.
// https://www.w3.org/TR/WCAG22/#contrast-minimum

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

const KINDS = ['label', 'passed', 'running', 'waiting', 'failed'];

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
const dark = (body: string) => new Map([...light, ...tokens(body)]);
const themes: [string, Map<string, string>][] = [
  ['light', light],
  [
    'prefers-color-scheme: dark',
    dark(
      block(
        block(css, '@media (prefers-color-scheme: dark)'),
        ':root:not([data-theme="light"])',
      ),
    ),
  ],
  ['data-theme=dark', dark(block(css, ':root[data-theme="dark"]'))],
];

function resolve(value: string, theme: Map<string, string>): string {
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (!ref) return value;
  const next = theme.get(ref[1]);
  if (!next) throw new Error(`${ref[1]} is not defined`);
  return resolve(next, theme);
}

function luminance(hex: string): number {
  const digits =
    hex.length === 4
      ? [...hex.slice(1)].map((c) => c + c).join('')
      : hex.slice(1);
  if (!/^[0-9a-f]{6}$/i.test(digits))
    throw new Error(`not a hex colour: ${hex}`);
  const n = Number.parseInt(digits, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
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

const declared = (body: string, prop: string) =>
  body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+?)\\s*(?:;|$)`))?.[1];

// Ratios below 4.5:1 for the segments of a stylesheet, per theme.
function failures(source: string, theme: Map<string, string>): string[] {
  const bg = resolve(
    declared(block(source, '.ci-pill.segmented {'), 'background') ?? '',
    theme,
  );
  return KINDS.flatMap((kind) => {
    const color = declared(block(source, `.ci-seg-${kind} {`), 'color');
    if (!color) return [`.ci-seg-${kind} sets no color`];
    const r = ratio(resolve(color, theme), bg);
    return r >= 4.5 ? [] : [`.ci-seg-${kind} is ${r.toFixed(2)}:1`];
  });
}

describe('Running pill colours', () => {
  test('the pill draws its own background, never a state tint', () => {
    expect(declared(block(css, '.ci-pill.segmented {'), 'background')).toBe(
      'var(--surface-sunken)',
    );
  });

  for (const [name, theme] of themes) {
    test(`every segment reads at 4.5:1 on the pill in the ${name} theme`, () => {
      expect(failures(css, theme)).toEqual([]);
    });
  }

  test('fails when a segment colour is made unreadable', () => {
    const bad = css.replace(
      /(\.ci-seg-waiting \{[^}]*color:)\s*[^;]+;/,
      '$1 #ffff00;',
    );
    expect(failures(bad, light)).toEqual(['.ci-seg-waiting is 1.00:1']);
  });
});
