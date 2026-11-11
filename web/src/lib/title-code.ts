// Dependabot and Renovate wrap digests and versions in backticks. The dialog
// title shows each paired span as code, without the backticks. The result is
// plain data for Svelte text nodes, so nothing is ever parsed as HTML.
// https://github.com/alrayyes/forge-dashboard/issues/3358

export interface TitleSegment {
  code: boolean;
  text: string;
}

/**
 * Split a title at paired backticks. An odd number of backticks, or an empty
 * pair, leaves the title as typed.
 */
export function titleSegments(title: string): TitleSegment[] {
  if (title === '') return [];
  const parts = title.split('`');
  // An odd tick count gives an even part count.
  const oddTicks = parts.length % 2 === 0;
  const emptySpan = parts.some((p, i) => i % 2 === 1 && p === '');
  if (parts.length === 1 || oddTicks || emptySpan) {
    return [{ code: false, text: title }];
  }
  return parts
    .map((text, i) => ({ code: i % 2 === 1, text }))
    .filter((s) => s.text !== '');
}
