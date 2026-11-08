/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The hint text in the Issues "hide title regex" field and the Branches search
// box, against each field's own background, in both themes. With no
// `::placeholder` rule Chrome paints #757575, which misses 4.5:1 on some of
// these backgrounds. 4.5:1 is WCAG 2.2 SC 1.4.3; placeholder text is text.
// https://www.w3.org/TR/WCAG22/#contrast-minimum
// https://github.com/alrayyes/forge-dashboard/issues/3201

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const branches = readFileSync(
  new URL('../routes/(app)/+page.svelte', import.meta.url),
  'utf8',
);

const CHROME_DEFAULT_PLACEHOLDER = '#757575';

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
const dark = new Map([
  ...light,
  ...tokens(block(css, ':root[data-theme="dark"]')),
]);
const themes: [string, Map<string, string>][] = [
  ['light', light],
  ['dark', dark],
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

const declared = (body: string, prop: string) =>
  body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+?)\\s*(?:;|$)`))?.[1];

// The body of the first rule whose selector list contains `selector`.
function ruleFor(source: string, selector: string): string {
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((x) => x.trim());
    if (list.includes(selector)) return m[2];
  }
  return '';
}

const FIELDS = [
  {
    name: 'Issues hide-title regex',
    source: css,
    field: '.text-filter input[type="text"]',
    placeholder: '.text-filter input::placeholder',
  },
  {
    name: 'Branches search',
    source: branches,
    field: '.mb-search',
    placeholder: '.mb-search::placeholder',
  },
];

function measure(f: (typeof FIELDS)[number], theme: Map<string, string>) {
  const body = ruleFor(f.source, f.field);
  const background = declared(body, 'background');
  const text = declared(body, 'color');
  if (!background || !text)
    throw new Error(`${f.field} lacks colour or background`);
  const own = declared(ruleFor(f.source, f.placeholder), 'color');
  const bg = resolve(background, theme);
  const hint = own ? resolve(own, theme) : CHROME_DEFAULT_PLACEHOLDER;
  return { hint: ratio(hint, bg), typed: ratio(resolve(text, theme), bg) };
}

describe('placeholder colours', () => {
  for (const f of FIELDS) {
    for (const [name, theme] of themes) {
      test(`${f.name} placeholder reads at 4.5:1 in the ${name} theme`, () => {
        expect(measure(f, theme).hint).toBeGreaterThanOrEqual(4.5);
      });

      test(`${f.name} placeholder stays dimmer than typed text in the ${name} theme`, () => {
        const { hint, typed } = measure(f, theme);
        expect(typed).toBeGreaterThan(hint);
      });
    }
  }
});
