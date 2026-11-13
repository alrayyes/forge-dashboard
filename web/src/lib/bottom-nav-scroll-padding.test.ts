/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The root keeps focused controls clear of the fixed bottom nav on phones.
// https://github.com/alrayyes/forge-dashboard/issues/3209

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

function block(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`no ${header} in style.css`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unclosed ${header}`);
}

describe('bottom nav scroll padding', () => {
  const header = '\n@media (max-width: 420px) {';
  const phone = block(css, header);

  test('html reserves the nav height, gap and safe-area inset on phones', () => {
    const m = phone.match(/(?:^|\s)html\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m?.[1].replace(/\s+/g, ' ')).toContain(
      'scroll-padding-bottom: calc( 46px + 12px + env(safe-area-inset-bottom, 0px) + var(--text-grow) )',
    );
  });

  test('wider screens leave scroll-padding-bottom alone', () => {
    const outside = css.replace(phone, '');
    expect(outside).not.toMatch(/scroll-padding-bottom/);
  });
});
