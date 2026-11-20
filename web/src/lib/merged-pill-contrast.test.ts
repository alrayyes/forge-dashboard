/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The Merged pill (#4406) is a pull request state drawn like the Passed pill
// in a purple of its own. The ratios are measured here, the way
// ci-pill-contrast.test.ts does it, because axe files a tinted pill's text as
// "incomplete" and never looks at a glyph. 4.5:1 is WCAG 1.4.3 for the word;
// 3:1 is 1.4.11 for the glyph and the edge.
// https://www.w3.org/TR/WCAG22/#contrast-minimum
// https://www.w3.org/TR/WCAG22/#non-text-contrast

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

// The body of the flat rule whose selector list holds `selector`.
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
  const digits = hex.slice(1);
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

function dim(hex: string, factor: number): string {
  const mix = rgb(hex).map((v) =>
    Math.round(v * factor)
      .toString(16)
      .padStart(2, '0'),
  );

  return `#${mix.join('')}`;
}

const declared = (body: string, prop: string) =>
  body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+?)\\s*(?:;|$)`))?.[1];

// Where the pair is drawn: the row's badge, the dialog's chip, and the word in
// the Related band's pill.
const ROW = '.row-settled[data-state="merged"]';
const CHIP = '.attr-chip.merged-pill';
const WORD = '.linked-pr-merged';

function pair(source: string, selector: string, theme: Map<string, string>) {
  const body = rule(source, selector);
  const fg = declared(body, 'color');
  if (!fg) throw new Error(`${selector} sets no color`);
  const bg = declared(body, 'background');

  return {
    fg: resolve(fg, theme),
    bg: bg ? resolve(bg, theme) : undefined,
  };
}

// Nothing Merged dims on hover today: the badge, the chip and the band word
// aren't buttons. `button.ci-pill:hover` (#2004) is the dim the check pills
// get, a brightness filter that scales text and background alike. It is read
// here as a guard for a future hover rule on a Merged pill: if one reuses that
// dim, the pair has to survive it. Dropping it from this check is fine the day
// that can't happen.
function factor(source: string): number {
  const f = declared(block(source, 'button.ci-pill:hover {'), 'filter');
  const n = f?.match(/^brightness\(([\d.]+)\)$/)?.[1];
  if (!n) throw new Error(`the hover filter is not a brightness: ${f}`);

  return Number(n);
}

function failures(source: string, theme: Map<string, string>): string[] {
  const out: string[] = [];
  const surface = resolve('var(--surface)', theme);
  const sunken = resolve('var(--surface-sunken)', theme);
  const dimmed = factor(source);
  for (const selector of [ROW, CHIP]) {
    const { fg, bg } = pair(source, selector, theme);
    if (!bg) {
      out.push(`${selector} sets no background`);
      continue;
    }
    const word = ratio(fg, bg);
    if (word < 4.5) out.push(`${selector} word is ${word.toFixed(2)}:1`);
    // What a pill would read like if it took the check pills' hover dim.
    const hovered = ratio(dim(fg, dimmed), dim(bg, dimmed));
    if (hovered < 4.5)
      out.push(
        `${selector} word under the check pills' hover dim is ${hovered.toFixed(2)}:1`,
      );
    const glyph = ratio(fg, surface);
    if (glyph < 3) out.push(`${selector} glyph is ${glyph.toFixed(2)}:1`);
  }
  // The Related band's pill sits on the sunken surface; only the word is
  // purple there, and it is read as text and drawn as a glyph-free word.
  const { fg } = pair(source, WORD, theme);
  const band = ratio(fg, sunken);
  if (band < 4.5) out.push(`${WORD} is ${band.toFixed(2)}:1 on the band pill`);
  const edge = ratio(
    resolve(`var(--merged)`, theme),
    resolve('var(--surface)', theme),
  );
  if (edge < 3) out.push(`the chip edge is ${edge.toFixed(2)}:1`);

  return out;
}

describe('Merged pill colours', () => {
  for (const [name, theme] of themes) {
    test(`the word, glyph, edge and a dimmed pair read in the ${name} theme`, () => {
      expect(failures(css, theme)).toEqual([]);
    });
  }

  test('names the tokens the ticket specifies', () => {
    expect(light.get('--merged')).toBe('#6d3fc0');
    expect(light.get('--merged-bg')).toBe('#f1eafd');
    for (const [, theme] of themes.slice(1)) {
      expect(theme.get('--merged')).toBe('#b79bf0');
      expect(theme.get('--merged-bg')).toBe('#241a3a');
    }
  });

  test('draws the row, the chip and the band word in the Merged pair', () => {
    for (const [, theme] of themes) {
      const want = {
        fg: resolve('var(--merged)', theme),
        bg: resolve('var(--merged-bg)', theme),
      };
      expect(pair(css, ROW, theme)).toEqual(want);
      expect(pair(css, CHIP, theme)).toEqual(want);
      expect(pair(css, WORD, theme).fg).toBe(want.fg);
    }
  });

  test('a Closed row stays neutral', () => {
    const body = rule(css, '.row-settled');
    expect(declared(body, 'background')).toBe('var(--neutral-bg)');
    expect(declared(body, 'color')).toBe('var(--ink)');
  });

  test('fails when the Merged colour is made unreadable', () => {
    const bad = css.replace(/(--merged:)\s*#6d3fc0;/, '$1 #ffff00;');
    expect(failures(bad, tokens(block(bad, ':root {'))).length).toBeGreaterThan(
      0,
    );
  });

  test("fails when the check pills' hover dim is made too strong", () => {
    const bad = css.replace(
      /(button\.ci-pill:hover \{[^}]*filter:)\s*[^;]+;/,
      '$1 brightness(0.5);',
    );
    expect(failures(bad, light).length).toBeGreaterThan(0);
  });
});
