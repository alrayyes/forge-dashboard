/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The edge of a text field or dropdown is the part of it that identifies it,
// so it needs 3:1 against what it sits on (WCAG 2.2 SC 1.4.11).
// https://www.w3.org/TR/WCAG22/#non-text-contrast
// --border-strong is 1.62:1 on white, so the filter controls take their own
// token and --border-strong stays a divider colour.
// https://github.com/alrayyes/forge-dashboard/issues/3193

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const branches = readFileSync(
  new URL('../routes/(app)/+page.svelte', import.meta.url),
  'utf8',
);

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
const darkMedia = tokens(
  block(
    block(css, '@media (prefers-color-scheme: dark)'),
    ':root:not([data-theme="light"])',
  ),
);
const darkAttr = tokens(block(css, ':root[data-theme="dark"]'));
const themes: [string, Map<string, string>][] = [
  ['light', light],
  ['prefers-color-scheme: dark', new Map([...light, ...darkMedia])],
  ['data-theme=dark', new Map([...light, ...darkAttr])],
];

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

// Does any rule whose selector mentions `selector` set its border from the token?
function usesToken(source: string, selector: string): boolean {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
    (m) =>
      m[1].includes(selector) &&
      /border(?:-color)?:[^;]*var\(--control-border\)/.test(m[2]),
  );
}

describe('--control-border', () => {
  for (const [name, theme] of themes) {
    test(`reads at 3:1 on --surface in the ${name} theme`, () => {
      const border = theme.get('--control-border');
      const surface = theme.get('--surface');
      if (!border || !surface) throw new Error('token missing');
      expect(ratio(border, surface)).toBeGreaterThanOrEqual(3);
    });
  }

  test('is #7c8a9b in light and #5f6d82 in dark', () => {
    expect(light.get('--control-border')).toBe('#7c8a9b');
    expect(darkMedia.get('--control-border')).toBe('#5f6d82');
    expect(darkAttr.get('--control-border')).toBe('#5f6d82');
  });

  test('--border-strong stays a divider colour', () => {
    expect(light.get('--border-strong')).toBe('#c3ccd6');
    expect(darkAttr.get('--border-strong')).toBe('#2e3947');
  });

  for (const selector of [
    '.col-filter',
    '.group-select',
    '.pagination-size select',
  ]) {
    test(`${selector} draws its border from the token`, () => {
      expect(usesToken(css, selector)).toBe(true);
    });
  }

  test('.mb-search on the Branches page draws its border from the token', () => {
    expect(usesToken(branches, '.mb-search')).toBe(true);
  });
});
