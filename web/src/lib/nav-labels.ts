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

// The header icon has only the pills on screen, so the name leads with the
// page: "Pull requests, 15 total, 2 failing, 10 passing, 3 running". With no
// count, or none listed, just the page.
export function headerLabel(name: string, count: Count): string {
  if (!count || count.total === 0) return name;
  return `${name}, ${count.total} total${states(count)}`;
}

// The tab shows the numbers above its word, so the name reads the same way
// round: "15 PRs, 2 failing, 10 passing, 3 running". `short` is the word on
// the tab ("PRs").
export function tabLabel(short: string, count: Count): string {
  if (!count || count.total === 0) return short;
  return `${count.total} ${short}${states(count)}`;
}
