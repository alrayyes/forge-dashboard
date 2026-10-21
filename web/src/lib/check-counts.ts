// The CI pills' counts (#2004, #2074): how many of a pull request's or a
// default branch's checks passed, are running, are waiting and failed. The
// server tallies them (`checks`); this only orders and words them, the way the
// menu pills do, and never works a count out itself.

export type CheckCounts = {
  passed: number;
  running: number;
  waiting: number;
  failed: number;
  // How many of the passed ones were skipped: inside passed, never beside it.
  // Absent from older answers, which reads as none.
  skipped?: number;
};

export type CheckKind = keyof CheckCounts;

// The order the pill draws them in and the link's name reads them in: what is
// done, what is going, what has not started, then what broke.
export const CHECK_KINDS: readonly CheckKind[] = [
  'passed',
  'skipped',
  'running',
  'waiting',
  'failed',
];

// The glyph each count is drawn with: the shapes the pipeline panel uses for
// the same states (check-glyphs.ts), so a state reads the same everywhere.
export const CHECK_KIND_GLYPH: Record<CheckKind, string> = {
  passed: 'success',
  skipped: 'skipped',
  running: 'running',
  waiting: 'queued',
  failed: 'failure',
};

export type CheckSegment = { kind: CheckKind; n: number };

// The counts to draw, in order, with a zero never drawn. Nothing at all for no
// counts, which leaves the plain pill.
//
// Skipped is a subset of passed (the server keeps passed whole, so it still
// counts every check that needs nothing more), drawn as its own segment beside
// it. When every passed check was skipped nothing really passed, so the passed
// segment gives way and the pill reads as skipped alone.
export function checkSegments(counts: CheckCounts | undefined): CheckSegment[] {
  if (!counts) return [];
  const skipped = counts.skipped ?? 0;

  return CHECK_KINDS.flatMap((kind) => {
    const n = counts[kind];
    if (kind === 'passed' && skipped > 0 && n === skipped) return [];

    return n !== undefined && Number.isInteger(n) && n > 0 ? [{ kind, n }] : [];
  });
}

// What a screen reader hears: the visible text first, word and counts spelt
// the way the pill's own text reads, so the name contains it whole (WCAG 2.5.3,
// which axe measures as label-content-name-mismatch), and then each count in
// words. The word is the pill's own: Running, Passed or Failed.
export function pillName(label: string, segments: CheckSegment[]): string {
  const visible = [label, ...segments.map((s) => String(s.n))].join(' ');
  const words = segments.map((s) => `${s.n} ${s.kind}`).join(', ');

  return `${visible}: ${words}`;
}
