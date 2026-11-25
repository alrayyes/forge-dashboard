/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The colours of the regex tokens in Settings' Ignored issue titles list
// (#4852), against the card they sit on, in each theme, read from the
// stylesheets. 4.5:1 is WCAG 2.2 1.4.3 for text. Each token class also needs a
// text style of its own (weight, slant or underline), so colour is never the
// only carrier and the list still reads with forced colours on (1.4.1).
// https://www.w3.org/TR/WCAG22/#use-of-color

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const page = readFileSync(
  new URL('../routes/(app)/settings/+page.svelte', import.meta.url),
  'utf8',
);
const KINDS = ['anchor', 'escape', 'group', 'class', 'quantifier', 'literal'];

function block(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector}`);
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
const themes: [string, Map<string, string>][] = [
  ['light', light],
  [
    'prefers-color-scheme: dark',
    new Map([
      ...light,
      ...tokens(
        block(
          block(css, '@media (prefers-color-scheme: dark)'),
          ':root:not([data-theme="light"])',
        ),
      ),
    ]),
  ],
  [
    'data-theme=dark',
    new Map([...light, ...tokens(block(css, ':root[data-theme="dark"]'))]),
  ],
];

function resolve(value: string, theme: Map<string, string>): string {
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (!ref) return value;
  const next = theme.get(ref[1]);
  if (!next) throw new Error(`${ref[1]} is not defined`);
  return resolve(next, theme);
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const rule = (kind: string) => block(page, `.rx-${kind} {`);
const declared = (body: string, prop: string) =>
  body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+?)\\s*(?:;|$)`))?.[1];

// What sets one token class apart from plain text besides its colour.
const style = (kind: string) =>
  ['font-weight', 'font-style', 'text-decoration']
    .map((p) => `${p}:${declared(rule(kind), p) ?? ''}`)
    .join(';');

describe('regex token styles', () => {
  test('every token class has a rule that sets a colour', () => {
    for (const kind of KINDS)
      expect(declared(rule(kind), 'color')).toBeTruthy();
  });

  for (const [name, theme] of themes) {
    test(`colours hold 4.5:1 on the card in ${name}`, () => {
      const card = resolve('var(--surface)', theme);
      for (const kind of KINDS) {
        const colour = resolve(declared(rule(kind), 'color') ?? '', theme);
        expect(`${kind} ${ratio(colour, card) >= 4.5}`).toBe(`${kind} true`);
      }
    });
  }

  test('each coloured token class has a text style of its own', () => {
    const coloured = KINDS.filter((k) => k !== 'literal');
    const styles = coloured.map(style);
    for (const [i, s] of styles.entries()) {
      expect(`${coloured[i]} ${s}`).not.toBe(
        `${coloured[i]} font-weight:;font-style:;text-decoration:`,
      );
    }
    expect(new Set(styles).size).toBe(coloured.length);
  });
});
