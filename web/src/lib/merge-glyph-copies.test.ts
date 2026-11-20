/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MERGE_GLYPH } from './check-glyphs';

// The merge glyph is drawn twice (#4455): as markup in check-glyphs.ts for the
// row badge, and as plain Svelte markup in the dialog, which can't use
// {@html} without tripping Semgrep's svelte-at-html rule. This test ties the
// copies together, so changing one shape without the other fails here.

const dialog = readFileSync(
  new URL('./PullRequestDetailsDialog.svelte', import.meta.url),
  'utf8',
);

// Every shape inside the svg, as `tag attr="value"` strings in document order.
function shapes(markup: string): string[] {
  return [...markup.matchAll(/<(circle|path)\b([^>]*?)\/?>/g)].map(
    ([, tag, attrs]) => `${tag} ${attrs.trim().replace(/\s+/g, ' ')}`,
  );
}

function dialogGlyph(source: string): string {
  const open = source.indexOf('class="merged-glyph"');
  if (open < 0) throw new Error('no merged-glyph svg in the dialog');
  const end = source.indexOf('</svg', open);

  return source
    .slice(open, end)
    .replace(/<!--[\s\S]*?-->/g, '')
    .slice(source.slice(open, end).indexOf('>') + 1);
}

describe('the merge glyph copies', () => {
  test('the dialog draws the same shapes as MERGE_GLYPH', () => {
    const copy = shapes(dialogGlyph(dialog));
    expect(copy.length).toBeGreaterThan(0);
    expect(copy).toEqual(shapes(MERGE_GLYPH));
  });

  test('fails when a shape in the dialog drifts', () => {
    const bad = dialog.replace('<circle cx="10.2"', '<circle cx="10.4"');
    expect(shapes(dialogGlyph(bad))).not.toEqual(shapes(MERGE_GLYPH));
  });

  test('fails when the dialog drops a shape', () => {
    const bad = dialog.replace(/<circle cx="6" cy="10.6" r="1" \/>\s*/, '');
    expect(shapes(dialogGlyph(bad))).not.toEqual(shapes(MERGE_GLYPH));
  });
});
