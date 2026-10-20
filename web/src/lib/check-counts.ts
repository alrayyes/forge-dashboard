// The Running pill's counts (#2004): how many of a pull request's checks
// passed, are running, are waiting and failed. The server tallies them
// (`checks` on the pull request); this only orders and words them, the way the
// menu pills do, and never works a count out itself.

export type CheckCounts = {
  passed: number;
  running: number;
  waiting: number;
  failed: number;
};

export type CheckKind = keyof CheckCounts;

// The order the pill draws them in and the link's name reads them in: what is
// done, what is going, what has not started, then what broke.
export const CHECK_KINDS: readonly CheckKind[] = [
  'passed',
  'running',
  'waiting',
  'failed',
];

// The glyph each count is drawn with: the shapes the pipeline panel uses for
// the same states (check-glyphs.ts), so a state reads the same everywhere.
export const CHECK_KIND_GLYPH: Record<CheckKind, string> = {
  passed: 'success',
  running: 'running',
  waiting: 'queued',
  failed: 'failure',
};

export type CheckSegment = { kind: CheckKind; n: number };

// The counts to draw, in order, with a zero never drawn. Nothing at all for no
// counts, which leaves the plain pill.
export function checkSegments(counts: CheckCounts | undefined): CheckSegment[] {
  if (!counts) return [];

  return CHECK_KINDS.flatMap((kind) => {
    const n = counts[kind];

    return Number.isInteger(n) && n > 0 ? [{ kind, n }] : [];
  });
}

// What a screen reader hears: the visible text first, word and counts spelt
// the way the pill's own text reads, so the name contains it whole (WCAG 2.5.3,
// which axe measures as label-content-name-mismatch), and then each count in
// words.
export function runningPillName(segments: CheckSegment[]): string {
  const visible = ['Running', ...segments.map((s) => String(s.n))].join(' ');
  const words = segments.map((s) => `${s.n} ${s.kind}`).join(', ');

  return `${visible}: ${words}`;
}
