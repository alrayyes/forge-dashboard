// The CI pills' counts (#2004, #2074): how many of a pull request's or a
// default branch's checks passed, are running, are waiting and failed. The
// server tallies them (`checks`); this orders and words them, the way the menu
// pills do, and only takes the skipped ones out of passed so they are drawn
// once. It never tallies a count itself.

export type CheckCounts = {
  passed: number;
  running: number;
  waiting: number;
  failed: number;
  // How many of the passed ones were skipped: inside passed, never beside it.
  // The server always sends it; optional here only because an older server
  // does not, which reads as none.
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

// Whether a pass was only skipped checks: the pill's state is the passed one
// and the one segment it draws is the skipped one.
export function onlySkipped(cls: string, segments: CheckSegment[]): boolean {
  return (
    cls === 'success' && segments.length === 1 && segments[0].kind === 'skipped'
  );
}

// The word a pill leads with. A pass where every passed check was skipped has
// only the skipped segment, and "Passed" over a lone slash would claim more
// than happened, so it says Skipped, as the pipeline dialog words the state.
// It keys on the pill's status class, so rewording the label cannot turn it off.
export function pillWord(
  cls: string,
  label: string,
  segments: CheckSegment[],
): string {
  return onlySkipped(cls, segments) ? 'Skipped' : label;
}

// The counts to draw, in order, with a zero never drawn. Nothing at all for no
// counts, which leaves the plain pill.
//
// Skipped is a subset of passed on the wire (the server keeps passed whole, so
// it still counts every check that needs nothing more), but the pill draws the
// two apart: passed is the checks that passed and were not skipped, skipped
// the ones that were. Drawn whole beside skipped, passed would count a skipped
// check twice and the segments would add up to more than the checks listed.
// When every passed check was skipped the passed segment is empty and the pill
// reads as skipped alone.
export function checkSegments(counts: CheckCounts | undefined): CheckSegment[] {
  if (!counts) return [];
  // Skipped is part of passed, so it can never exceed it; a larger figure is
  // a mistake upstream and is held to passed rather than drawn as a contradiction.
  const raw = counts.skipped ?? 0;
  const skipped = Number.isInteger(raw)
    ? Math.max(0, Math.min(raw, counts.passed))
    : 0;

  return CHECK_KINDS.flatMap((kind) => {
    const n =
      kind === 'skipped'
        ? skipped
        : kind === 'passed'
          ? counts.passed - skipped
          : counts[kind];

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
