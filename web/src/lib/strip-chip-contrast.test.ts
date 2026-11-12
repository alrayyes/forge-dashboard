/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The count chips on the Rebase all strip (#3276): each
// chip's text against its own fill, in both themes, read from the stylesheet.
// 4.5:1 is WCAG 2.2 1.4.3. The zero state of every chip is the neutral one,
// so "0 failing" is measured too, and --neutral is not used as text: it is
// 3.10:1 on its fill in light.
// https://www.w3.org/TR/WCAG22/#contrast-minimum

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

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
  const raw = hex.replace('#', '');
  const digits = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw;
  if (!/^[0-9a-f]{6}$/i.test(digits)) throw new Error(`not a hex: ${hex}`);
  const n = Number.parseInt(digits, 16);
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

const declared = (body: string, prop: string) =>
  body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+?)\\s*(?:;|$)`))?.[1];

const chips: [string, string][] = [
  ['neutral (a zero count, and "listed")', '.strip-chip {'],
  ['out of date', '.strip-chip.warn {'],
  ['failing', '.strip-chip.bad {'],
];

function failures(source: string, theme: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [name, selector] of chips) {
    const body = block(source, selector);
    const text = resolve(declared(body, 'color') ?? '', theme);
    const fill = resolve(declared(body, 'background') ?? '', theme);
    const r = ratio(text, fill);
    if (r < 4.5) out.push(`${name} is ${r.toFixed(2)}:1`);
  }
  return out;
}

describe('strip chip colours', () => {
  for (const [name, theme] of themes) {
    test(`every chip reads at 4.5:1 on its fill in the ${name} theme`, () => {
      expect(failures(css, theme)).toEqual([]);
    });
  }

  test('the neutral chip uses --ink-2 on --neutral-bg', () => {
    const body = block(css, '.strip-chip {');
    expect(declared(body, 'color')).toBe('var(--ink-2)');
    expect(declared(body, 'background')).toBe('var(--neutral-bg)');
  });

  test('a pale pair fails', () => {
    const sheet =
      '.strip-chip { color: #ccc; background: #fff; }\n.strip-chip.warn { color: #000; background: #fff; }\n.strip-chip.bad { color: #000; background: #fff; }';
    expect(failures(sheet, light)).toHaveLength(1);
  });
});
