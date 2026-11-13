import { isPlainClick } from './plain-click.js';

// A `#12` or `owner/repo#12` in rendered Markdown for a repository the
// dashboard tracks is a real link to the dashboard's own address that also
// carries the repository and number (markdown.ts). This reads them back from
// a click so the dialog host can open that item where the reader is, and
// leaves a modified or middle click to the browser.

export type ClickedReference = {
  repo: string;
  number: number;
  /** The item's page on the forge, for a dialog that has nothing else to show. */
  url: string;
  anchor: unknown;
};

export function referenceFromClick(
  event: Pick<
    MouseEvent,
    | 'defaultPrevented'
    | 'button'
    | 'metaKey'
    | 'ctrlKey'
    | 'shiftKey'
    | 'altKey'
  > & { target: unknown },
): ClickedReference | null {
  if (!isPlainClick(event)) return null;
  const target = event.target as {
    closest?: (selector: string) => unknown;
  } | null;
  const anchor = target?.closest?.('a[data-ref-number]') as {
    dataset: { refRepo?: string; refNumber?: string; refUrl?: string };
  } | null;
  const { refRepo, refNumber, refUrl } = anchor?.dataset ?? {};
  if (!anchor || !refRepo || !refNumber || !/^[0-9]+$/.test(refNumber))
    return null;
  return {
    repo: refRepo,
    number: Number(refNumber),
    url: refUrl ?? '',
    anchor,
  };
}
