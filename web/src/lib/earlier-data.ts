// That a forge isn't answering is said once above the list (#5127). An affected
// row carries a short marker instead of the whole sentence. These are the words
// and the test for which row that is.

export const EARLIER_DATA_LABEL = 'Earlier data';

// The server gives a row it carried over this status, with the sentence that
// says why. A row waiting on something of its own has another code, and keeps
// its words.
export function isEarlierData(status?: { code?: string } | null): boolean {
  return status?.code === 'forge_unreachable';
}

// The line the unreachable banner adds. The banner already names the forge and
// the age of the rows, so this says neither.
export const EARLIER_DATA_BANNER_LINE = `Rows marked ${EARLIER_DATA_LABEL} may be an earlier answer, and no action can run on them while this lasts.`;

// The notice for a forge the banner doesn't cover, such as one still starting
// up. Cut around the relative age so the page can tick that part alone.
export function earlierDataNotice(
  forges: readonly { label: string; staleSince?: string }[],
  ago: (iso: string) => string,
): {
  before: string;
  age?: { since: string; text: string };
  after: string;
} {
  const one = forges.length === 1;
  const names = forges.map((f) => f.label).join(' and ');
  // The oldest rows on screen are the ones to be careful with.
  const since = forges
    .map((f) => f.staleSince)
    .filter((s): s is string => !!s)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    before: `${names} ${one ? "isn't" : "aren't"} answering yet, so rows marked ${EARLIER_DATA_LABEL} may be an earlier answer${since ? ' from ' : ''}`,
    age: since ? { since, text: ago(since) } : undefined,
    after: `, and no action can run on them until ${one ? 'it does' : 'they do'}.`,
  };
}
