/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The attribute chips on a row (auto-merge on, draft, bot, out of date,
// #1563): their text, and the icon drawn in the same colour, against the two
// backgrounds a row has, in both themes, read from the stylesheet. The chip
// is outlined with no fill of its own, so the row's --surface (or
// --surface-sunken on hover) is what sits behind it. 4.5:1 is WCAG 2.2
// 1.4.3 for text, which also covers the icon's 3:1 (1.4.11).
// https://www.w3.org/TR/WCAG22/#contrast-minimum
// The outline is not measured: the word names the chip, so the outline is not
// needed to identify it (1.4.11 covers parts needed to understand a control).

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

// The chip's own declarations, found from the stylesheet. Anything that could
// change what is measured without being measured is a problem.
function chipProblems(source: string): string[] {
  const problems: string[] = [];
  const own = block(source, '.attr-chip {');
  if (!declared(own, 'color')) problems.push('.attr-chip sets no color');
  if (declared(own, 'background') !== 'transparent')
    problems.push('.attr-chip draws a fill');
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
    if (!/\.attr-chip\b/.test(selectors) || selectors.trim() === '.attr-chip')
      continue;
    for (const prop of ['color', 'background', 'opacity', 'border-color']) {
      if (declared(m[2], prop))
        problems.push(`${selectors.trim()} sets ${prop}`);
    }
  }
  return problems;
}

function failures(source: string, theme: Map<string, string>): string[] {
  const own = block(source, '.attr-chip {');
  const text = resolve(declared(own, 'color') ?? '', theme);
  return ['--surface', '--surface-sunken'].flatMap((token) => {
    const bg = resolve(`var(${token})`, theme);
    const out: string[] = [];
    const t = ratio(text, bg);
    if (t < 4.5) out.push(`text on ${token} is ${t.toFixed(2)}:1`);
    return out;
  });
}

describe('attribute chip colours', () => {
  test('nothing else changes a chip colour, fill or opacity', () => {
    const problems = chipProblems(css);
    if (problems.length > 0)
      throw new Error(
        `Extend attr-chip-contrast.test.ts to measure this first: ${problems.join('; ')}`,
      );
  });

  for (const [name, theme] of themes) {
    test(`text and icon read at 4.5:1 in the ${name} theme`, () => {
      expect(failures(css, theme)).toEqual([]);
    });
  }
});

describe('on a synthetic stylesheet', () => {
  const sheet = (color: string, extra = '') =>
    `.attr-chip { color: ${color}; border: 1px solid var(--ink); background: transparent; }\n${extra}`;

  test('a pale text colour fails', () => {
    expect(failures(sheet('#ff0'), light).length).toBeGreaterThan(0);
  });

  test('an override, a fill and a missing rule are flagged', () => {
    expect(
      chipProblems(sheet('#000', '.attr-chip.draft { color: red; }')),
    ).toHaveLength(1);
    expect(chipProblems(sheet('#000').replace('transparent', '#eee'))).toEqual([
      '.attr-chip draws a fill',
    ]);
    expect(() => chipProblems('.nothing { }')).toThrow();
  });
});
