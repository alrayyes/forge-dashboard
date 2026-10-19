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

// The counts in the order the pill draws them (#1563): the outcomes, failing
// then passing, then the running state, then the branches without a pipeline.
// Zero is never spoken, as it is never drawn (#1439).
function states(count: NonNullable<Count>): string {
  const parts: string[] = [];
  if (count.failed > 0) parts.push(`${count.failed} failing`);
  if ((count.passed ?? 0) > 0) parts.push(`${count.passed} passing`);
  if ((count.running ?? 0) > 0) parts.push(`${count.running} running`);
  if ((count.none ?? 0) > 0) parts.push(`${count.none} without a pipeline`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

// The text the pill draws, in the order it draws it: the total, then the
// outcomes, then the running state, then the branches without a pipeline.
function drawn(count: NonNullable<Count>): string {
  return [count.total, count.failed, count.passed, count.running, count.none]
    .filter((n) => (n ?? 0) > 0)
    .join(' ');
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
