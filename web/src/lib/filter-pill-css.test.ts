/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// One filter pill, one stylesheet rule per concern (#4279). Forced colours
// drops the accent fill, so the pressed pill needs its own mark; it is written
// once, for the component, and no page restates it.

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

// The body of the first rule whose selector list contains `selector`.
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(
    new RegExp(
      `(?:^|\\})\\s*[^{}]*${escaped}(?=[\\s,{])[^{}]*\\{([^}]*)\\}`,
      'm',
    ),
  );
  return m?.[1] ?? '';
}

// The text of every @media block whose query matches.
function mediaBlocks(query: RegExp): string[] {
  const blocks: string[] = [];
  for (const m of css.matchAll(/@media\s*([^{]*)\{/g)) {
    if (!query.test(m[1])) continue;
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    blocks.push(css.slice(start, i - 1));
  }
  return blocks;
}

const forcedColourBlocks = () => mediaBlocks(/forced-colors:\s*active/);

describe('the shared filter pill', () => {
  test('is 32px high', () => {
    expect(rule('.filter-pill')).toMatch(/min-height:\s*32px/);
  });

  test('marks the pressed pill in forced colours from one rule', () => {
    const marks = forcedColourBlocks().filter((b) =>
      /\.filter-pill\[aria-pressed="true"\]/.test(b),
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatch(/Highlight/);
  });

  test('has no second pressed mark per page', () => {
    expect(css).not.toContain('.mb-pill');
  });

  test('widens the hit area to 44px on a phone, and only there, without growing the pill', () => {
    const phone = mediaBlocks(/\(max-width:\s*760px\)/);
    expect(
      phone.some((b) =>
        /\.filter-pill::after\s*\{[^}]*inset:\s*-7px -1px/.test(b),
      ),
    ).toBe(true);
    // Outside the phone blocks no rule gives the pill a pseudo-element.
    let rest = css;
    for (const b of phone) rest = rest.replace(b, '');
    expect(rest).not.toMatch(/\.filter-pill::after/);
  });

  test('keeps a pressed CI pill border on Highlight, past the tone rule', () => {
    const blocks = forcedColourBlocks().filter((b) =>
      /\.ci-filter-pill\[data-status\]\[aria-pressed="true"\]/.test(b),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatch(/border-color:\s*Highlight/);
  });
});
