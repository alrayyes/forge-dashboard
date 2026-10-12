// What assistive tech hears for a nav item with counts (#1315). The pills are
// aria-hidden, so the link's own name carries both numbers, and the name has
// to contain the words and numbers on screen (WCAG 2.5.3).

type Count = { total: number; failed: number } | null;

// The header icon has only the pills on screen, so the name leads with the
// page: "Branches, 12 total, 3 failing". With no count, or none listed, just
// the page.
export function headerLabel(name: string, count: Count): string {
  if (!count || count.total === 0) return name;
  const failing = count.failed > 0 ? `, ${count.failed} failing` : '';
  return `${name}, ${count.total} total${failing}`;
}

// The tab shows the numbers above its word, so the name reads the same way
// round: "12 Branches, 3 failing". `short` is the word on the tab ("PRs").
export function tabLabel(short: string, count: Count): string {
  if (!count || count.total === 0) return short;
  const failing = count.failed > 0 ? `, ${count.failed} failing` : '';
  return `${count.total} ${short}${failing}`;
}
