// What assistive tech hears for a nav item with counts (#1315, #1439). The
// pills are aria-hidden, so the link's own name carries every number, and the
// name has to contain the words and numbers on screen (WCAG 2.5.3).

type Count = {
  total: number;
  failed: number;
  running?: number;
  passed?: number;
  cancelled?: number;
  none?: number;
  noChecks?: number;
  awaitingApproval?: number;
} | null;

export type PillKind =
  | 'failed'
  | 'passed'
  | 'cancelled'
  | 'running'
  | 'awaiting'
  | 'none'
  | 'noChecks';

// The counts after the total, in the order the pill draws them (#1563): the
// outcomes (failing, passing, then cancelled, #3958), then the running state,
// then the branches held for approval (#2024), then the branches without a
// pipeline. Zero is never drawn or spoken (#1439). The pill
// (NavPills.svelte) and both names below build from this one list, so the
// order and the zero rule cannot drift apart (#1944).
export function pillParts(
  count: NonNullable<Count>,
): { kind: PillKind; n: number; words: string }[] {
  return [
    { kind: 'failed' as const, n: count.failed, words: 'failing' },
    { kind: 'passed' as const, n: count.passed ?? 0, words: 'passing' },
    { kind: 'cancelled' as const, n: count.cancelled ?? 0, words: 'cancelled' },
    { kind: 'running' as const, n: count.running ?? 0, words: 'running' },
    {
      kind: 'awaiting' as const,
      n: count.awaitingApproval ?? 0,
      words: 'waiting for approval',
    },
    {
      kind: 'none' as const,
      n: count.none ?? 0,
      words: 'without a pipeline',
    },
    {
      kind: 'noChecks' as const,
      n: count.noChecks ?? 0,
      words: 'without checks',
    },
  ].filter((part) => part.n > 0);
}

// Whether the pill draws the neutral total (#3489). It leaves it out only when
// exactly one category is present and that count is the total: "2 running" and
// not "2 2". With two categories, or one that falls short of the total (the
// rest sit in no category), the total says something the counts don't. The
// pill and both names ask here, so what is drawn and what is spoken agree.
export function showTotal(count: NonNullable<Count>): boolean {
  const parts = pillParts(count);
  return !(parts.length === 1 && parts[0].n === count.total);
}

function states(count: NonNullable<Count>): string {
  const parts = pillParts(count).map((p) => `${p.n} ${p.words}`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

// The text the pill draws, in the order it draws it: the total (unless
// showTotal leaves it out), then the rest.
function drawn(count: NonNullable<Count>): string {
  const total = showTotal(count) ? [count.total] : [];
  return [...total, ...pillParts(count).map((p) => p.n)].join(' ');
}

// The header icon has only the pills on screen. WCAG 2.5.3 wants the name to
// contain the visible text, so it opens with the numbers as drawn, then says
// them in words: "15 2 10 3, Pull requests, 15 total, 2 failing, 10 passing,
// 3 running". When the total only repeats the one count, it is neither drawn
// nor spoken: "2, Pull requests, 2 running". With no count, or none listed, just the page (#1944).
export function headerLabel(name: string, count: Count): string {
  if (!count || count.total === 0) return name;
  const total = showTotal(count) ? `, ${count.total} total` : '';
  return `${drawn(count)}, ${name}${total}${states(count)}`;
}

// The tab shows the numbers above its word, so the name reads the same way
// round: "15 2 10 3 PRs, 2 failing, 10 passing, 3 running". `short` is the word
// on the tab ("PRs").
export function tabLabel(short: string, count: Count): string {
  if (!count || count.total === 0) return short;
  return `${drawn(count)} ${short}${states(count)}`;
}
