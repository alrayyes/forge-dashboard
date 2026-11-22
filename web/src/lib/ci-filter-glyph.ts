import { checkGlyphElements } from '#lib/ci-pill.js';

// What the two CI-flavoured filter pills share: the status vocabulary, the CI
// pill glyph each status wears, and the action that draws it ahead of the word.
// `status` is the Main branches vocabulary and sets the tone; a page maps its
// own states onto it.
export type CiFilterStatus =
  | 'failed'
  | 'passed'
  | 'running'
  | 'cancelled'
  | 'awaiting_approval'
  | 'unknown'
  | 'none';

// The CI pill's glyph state for each status. No pipeline takes the skipped
// slash.
export const GLYPH_STATE: Record<CiFilterStatus, string> = {
  failed: 'failure',
  passed: 'success',
  running: 'running',
  cancelled: 'cancelled',
  awaiting_approval: 'awaiting_approval',
  unknown: 'unknown',
  none: 'skipped',
};

// Draws the glyphs ahead of the word. They are aria-hidden SVG, so the
// button's name stays the word and count. No status, no glyph.
export function ciFilterGlyph(
  node: HTMLElement,
  status: CiFilterStatus | undefined,
) {
  if (status) node.prepend(...checkGlyphElements(GLYPH_STATE[status]));
}
