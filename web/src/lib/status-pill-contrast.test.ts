/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The Main branches status pills wear the CI pill's colours (#4221): the glyph
// is tinted on the neutral pill, and a pressed pill takes its state's own pair.
// axe files text colour on a tinted pill as "incomplete" and never looks at a
// glyph, so the ratios are measured here, the way ci-pill-contrast.test.ts
// does it. 4.5:1 is WCAG 1.4.3 for the word and the count; 3:1 is 1.4.11 for
// the glyph and the pill's edge.
// https://www.w3.org/TR/WCAG22/#contrast-minimum
// https://www.w3.org/TR/WCAG22/#non-text-contrast

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

const STATUSES = [
  'failed',
  'passed',
  'running',
  'cancelled',
  'awaiting_approval',
  'unknown',
  'none',
];

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

// The body of the flat rule whose selector list holds `selector`, so a state
// that shares its pair with another (Running and Waiting) is found by either.
function rule(source: string, selector: string): string {
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((part) => part.trim());
    if (list.includes(selector)) return m[2];
  }
  throw new Error(`no ${selector} rule in style.css`);
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

function rgb(hex: string): [number, number, number] {
  const digits =
    hex.length === 4
      ? [...hex.slice(1)].map((c) => c + c).join('')
      : hex.slice(1);
  if (!/^[0-9a-f]{6}$/i.test(digits)) throw new Error(`not a hex: ${hex}`);
  const n = Number.parseInt(digits, 16);

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return (hi + 0.05) / (lo + 0.05);
}

// The colour of `fg` drawn at `alpha` over `bg`.
function over(fg: string, bg: string, alpha: number): string {
  const [f, b] = [rgb(fg), rgb(bg)];
  const mix = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)));

  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const declared = (body: string, prop: string) =>
  body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+?)\\s*(?:;|$)`))?.[1];

// A status pill's tone and tinted background, as the stylesheet declares them.
function tone(source: string, status: string, theme: Map<string, string>) {
  const body = rule(source, `.ci-filter-pill[data-status="${status}"]`);
  const read = (prop: string) => {
    const v = declared(body, prop);
    if (!v) throw new Error(`${status} sets no ${prop}`);

    return resolve(v, theme);
  };

  return { fg: read('--mb-tone'), bg: read('--mb-tone-bg') };
}

function failures(source: string, theme: Map<string, string>): string[] {
  const sunken = resolve('var(--surface-sunken)', theme);
  const page = resolve('var(--surface)', theme);
  const opacity = Number(theme.get('--pill-active-count-opacity'));
  const out: string[] = [];
  for (const status of STATUSES) {
    const { fg, bg } = tone(source, status, theme);
    const glyph = ratio(fg, sunken);
    if (glyph < 3) out.push(`${status} glyph is ${glyph.toFixed(2)}:1`);
    // A pressed pill's inset ring is drawn in currentColor, the tone. It is the
    // cue beyond fill, so on the neutral states it has to stand out from the
    // page by itself (1.4.11), not lean on a faint fill change (#4300).
    const ring = ratio(fg, page);
    if (ring < 3) out.push(`${status} pressed ring is ${ring.toFixed(2)}:1`);
    const word = ratio(fg, bg);
    if (word < 4.5) out.push(`${status} pressed word is ${word.toFixed(2)}:1`);
    const count = ratio(over(fg, bg, opacity), bg);
    if (count < 4.5)
      out.push(`${status} pressed count is ${count.toFixed(2)}:1`);
  }
  const edge = resolve(
    declared(rule(source, '.ci-filter-pill[data-status]'), 'border-color') ??
      '',
    theme,
  );
  const edgeRatio = ratio(edge, page);
  if (edgeRatio < 3) out.push(`the pill edge is ${edgeRatio.toFixed(2)}:1`);

  return out;
}

describe('Status pill colours', () => {
  for (const [name, theme] of themes) {
    test(`every glyph, pressed pair and edge reads in the ${name} theme`, () => {
      expect(failures(css, theme)).toEqual([]);
    });
  }

  test('states the pressed pairs the design names', () => {
    const pairs = Object.fromEntries(
      STATUSES.map((s) => [s, tone(css, s, light)]),
    );
    const expected = (fg: string, bg: string) => ({
      fg: resolve(`var(${fg})`, light),
      bg: resolve(`var(${bg})`, light),
    });
    expect(pairs.failed).toEqual(expected('--critical', '--critical-bg'));
    expect(pairs.passed).toEqual(expected('--good', '--good-bg'));
    expect(pairs.running).toEqual(expected('--warning', '--warning-bg'));
    expect(pairs.awaiting_approval).toEqual(
      expected('--warning', '--warning-bg'),
    );
    for (const s of ['cancelled', 'unknown', 'none']) {
      expect(pairs[s]).toEqual(expected('--ink-2', '--neutral-bg'));
    }
  });

  test('fails when a glyph colour is made unreadable', () => {
    const bad = css.replace(
      /(\.ci-filter-pill\[data-status="passed"\] \{[^}]*--mb-tone:)\s*[^;]+;/,
      '$1 #ffff00;',
    );
    expect(failures(bad, light).length).toBeGreaterThan(0);
  });

  test('fails when a neutral pill rings in a colour too faint for the page', () => {
    const bad = css.replace(
      /(\.ci-filter-pill\[data-status="none"\] \{[^}]*--mb-tone:)\s*[^;]+;/,
      '$1 #cccccc;',
    );
    expect(
      failures(bad, light).some((f) => f.includes('none pressed ring')),
    ).toBe(true);
  });

  test('fails when the edge is the faint divider colour', () => {
    const bad = css.replace(
      /(\.ci-filter-pill\[data-status\] \{[^}]*border-color:)\s*[^;]+;/,
      '$1 var(--border);',
    );
    expect(
      failures(bad, themes[1][1]).some((f) => f.includes('the pill edge')),
    ).toBe(true);
  });
});
