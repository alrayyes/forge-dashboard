// What assistive tech hears for a nav item with counts (#1315, #1439). The
// pills are aria-hidden, so the link's own name carries every number, and the
// name has to contain the words and numbers on screen (WCAG 2.5.3).

type Count = {
  total: number;
  failed: number;
  running?: number;
  passed?: number;
  none?: number;
} | null;

export type PillKind = 'failed' | 'passed' | 'running' | 'none';

// The counts after the total, in the order the pill draws them (#1563): the
// outcomes, failing then passing, then the running state, then the branches
// without a pipeline. Zero is never drawn or spoken (#1439). The pill
// (NavPills.svelte) and both names below build from this one list, so the
// order and the zero rule cannot drift apart (#1944).
export function pillParts(
  count: NonNullable<Count>,
): { kind: PillKind; n: number; words: string }[] {
  return [
    { kind: 'failed' as const, n: count.failed, words: 'failing' },
    { kind: 'passed' as const, n: count.passed ?? 0, words: 'passing' },
    { kind: 'running' as const, n: count.running ?? 0, words: 'running' },
    {
      kind: 'none' as const,
      n: count.none ?? 0,
      words: 'without a pipeline',
    },
  ].filter((part) => part.n > 0);
}

function states(count: NonNullable<Count>): string {
  const parts = pillParts(count).map((p) => `${p.n} ${p.words}`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

// The text the pill draws, in the order it draws it: the total, then the rest.
function drawn(count: NonNullable<Count>): string {
  return [count.total, ...pillParts(count).map((p) => p.n)].join(' ');
}

// The header icon has only the pills on screen. WCAG 2.5.3 wants the name to
// contain the visible text, so it opens with the numbers as drawn, then says
// them in words: "15 2 10 3, Pull requests, 15 total, 2 failing, 10 passing,
// 3 running". With no count, or none listed, just the page (#1944).
export function headerLabel(name: string, count: Count): string {
  if (!count || count.total === 0) return name;
  return `${drawn(count)}, ${name}, ${count.total} total${states(count)}`;
}

// The tab shows the numbers above its word, so the name reads the same way
// round: "15 2 10 3 PRs, 2 failing, 10 passing, 3 running". `short` is the word
// on the tab ("PRs").
export function tabLabel(short: string, count: Count): string {
  if (!count || count.total === 0) return short;
  return `${drawn(count)} ${short}${states(count)}`;
}
