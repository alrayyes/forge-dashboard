// That a forge isn't answering is said once above the list (#5127). An affected
// row carries a short marker instead of the whole sentence. These are the words
// and the tests for which row and which forge those are.

import { carriedOverLock, type ForgeHealthEntry } from './forge-lock';

export const EARLIER_DATA_LABEL = 'Earlier data';

// The server gives a row it carried over this status, with the sentence that
// says why. A row waiting on something of its own has another code, and keeps
// its words.
export function isEarlierData(status?: { code?: string } | null): boolean {
  return status?.code === 'forge_unreachable';
}

// The forge kinds to name above the list: those of the marked pull requests,
// all that are loaded and not only the drawn ones, so a filter or a page says
// nothing new. Health decides as well, since a held board keeps its marked rows
// after the forge answers. As the server does, a kind with any host that
// answers is not named.
export function earlierForges(
  items: readonly { forge: string; status?: { code?: string } | null }[],
  forges: readonly ForgeHealthEntry[],
): string[] {
  const marked = items.filter((i) => isEarlierData(i.status));
  return [...new Set(marked.map((i) => i.forge))]
    .sort((a, b) => a.localeCompare(b))
    .filter((kind) => {
      const hosts = forges.filter((f) => f.forge === kind);
      return (
        hosts.length > 0 &&
        hosts.every((f) => carriedOverLock([f], kind) !== null)
      );
    });
}

// The line the unreachable banner adds. The banner already names the forge and
// the age of the rows, so this says neither.
export const EARLIER_DATA_BANNER_LINE = `Rows marked ${EARLIER_DATA_LABEL} may be an earlier answer, and no action can run on them while this lasts.`;

// The notice for a forge the banner doesn't cover, such as one still starting
// up. Cut around the relative age so the page can tick that part alone. Beside
// a banner that already carries the sentence it only names the other forge.
export function earlierDataNotice(
  forges: readonly { label: string; staleSince?: string }[],
  ago: (iso: string) => string,
  besideBanner = false,
): {
  before: string;
  age?: { since: string; text: string };
  after: string;
} {
  const one = forges.length === 1;
  const names = forges.map((f) => f.label).join(' and ');
  const answering = `${names} ${one ? "isn't" : "aren't"} answering yet`;
  // The oldest rows on screen are the ones to be careful with.
  const since = forges
    .map((f) => f.staleSince)
    .filter((s): s is string => !!s)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const age = since ? { since, text: ago(since) } : undefined;
  if (besideBanner)
    return {
      before: `${answering} either${since ? `, and ${one ? 'its' : 'their'} rows are from ` : ''}`,
      age,
      after: '.',
    };
  return {
    before: `${answering}, so rows marked ${EARLIER_DATA_LABEL} may be an earlier answer${since ? ' from ' : ''}`,
    age,
    after: `, and no action can run on them until ${one ? 'it does' : 'they do'}.`,
  };
}
