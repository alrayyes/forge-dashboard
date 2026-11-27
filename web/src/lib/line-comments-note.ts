// What the pull request dialog says about review comments on lines of code
// (#5011). The server gives the count, not the comments, and whether it is a
// lower bound; this file only words it. The link's text is followed by the
// forge's name.

export function lineCommentsNote(
  count: number | undefined,
  truncated: boolean | undefined,
): { text: string; link: string } | null {
  if (!count) return null;
  const one = count === 1;
  const atLeast = truncated ? 'At least ' : '';
  const what =
    one && !truncated
      ? 'review comment on a line of code'
      : `review comment${one ? '' : 's'} on lines of code`;
  return {
    text: `${atLeast}${count} ${what} ${one ? "isn't" : "aren't"} shown here.`,
    // Past a lower bound there is more than one to read.
    link: one && !truncated ? 'Read it' : 'Read them',
  };
}
