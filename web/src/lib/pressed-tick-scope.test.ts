/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The overview's pressed pill draws a tick so the pick never rests on colour
// alone. A CI filter pill carries its pick in the glyph and the ring instead,
// so the tick rule leaves it out by its own selector, not by a second rule that
// cancels it (#4300).

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

// Every selector in the stylesheet that draws a pressed pill's ::before.
function tickSelectors(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .split(',')
      .map((part) => part.trim());
    for (const selector of selectors) {
      if (
        selector.includes('[aria-pressed="true"]') &&
        selector.endsWith('::before')
      ) {
        found.push(selector);
      }
    }
  }

  return found;
}

describe('The pressed pill tick', () => {
  test('is scoped away from the CI filter pill by its own selector', () => {
    const ticks = tickSelectors(css).filter((s) => s.includes('.quick-pill'));
    expect(ticks.length).toBeGreaterThan(0);
    for (const selector of ticks) {
      expect(selector).toContain(':not(.ci-filter-pill)');
    }
  });

  test('leaves no rule that cancels the tick on a CI filter pill', () => {
    const cancels = tickSelectors(css).filter(
      (s) =>
        s.includes('.ci-filter-pill') && !s.includes(':not(.ci-filter-pill)'),
    );
    expect(cancels).toEqual([]);
  });
});
