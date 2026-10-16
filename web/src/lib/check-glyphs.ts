// The glyphs a CI state or outcome is drawn with (#1473, #1563): the same
// shapes as the pull request row's CI slot, so a status reads the same on
// every page. Static markup, never built from forge data. The class names
// (`check-glyph check-glyph-<name>`) carry the styles in style.css, including
// the spinning arc and the still clock for prefers-reduced-motion.

export type CheckGlyph = { name: string; body: string };

const RING = '<circle cx="8" cy="8" r="6.25"/>';
const CROSS = `${RING}<path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4"/>`;

// Running carries both glyphs: the arc spins, the clock stays still when the
// visitor asks for less motion.
export const CHECK_GLYPHS: Record<string, CheckGlyph[]> = {
  success: [
    { name: 'check', body: `${RING}<path d="m5.3 8.2 1.9 1.9 3.5-3.9"/>` },
  ],
  failure: [{ name: 'cross', body: CROSS }],
  running: [
    { name: 'arc', body: '<path d="M8 1.75a6.25 6.25 0 1 1-6.25 6.25"/>' },
    { name: 'clock', body: `${RING}<path d="M8 4.6V8l2.3 1.4"/>` },
  ],
};
