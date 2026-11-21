// The pills on a pull request's dialog that link to the tickets it mentions
// without closing them. The server reads the title and description, decides
// what counts and says whether the dashboard tracks each ticket; this only
// words the pills. A tracked ticket opens on the Issues page, and one the
// dashboard does not hold is a plain link to its forge. The sibling of
// closing-issues.ts, which does the same for what a pull request closes.

import {
  type ClosingIssue,
  issueNumber,
  splitClosing,
} from './closing-issues.js';
import {
  addPillTip,
  focusPill,
  hasPillTitle,
  pillHoverText,
} from './pill-tip.js';
import { isPlainClick } from './plain-click.js';
import { createDwell } from './reference-dwell.js';
import { appendRepoRef, foldedPills } from './related-band.js';

/** Pull requests whose folded mentions the reader opened, so a redraw keeps them open. */
const expanded = new Set<string>();

/** Matches components.schemas.MentionedIssue in api/openapi.yaml. */
export type MentionedIssue = ClosingIssue & { tracked: boolean };

/**
 * How a pill for an item the dashboard does not track reaches the details
 * dialog (#4321), the way a mention in the description does (#4269). `warm`
 * asks the forge while the pointer or focus rests on the pill. `open` swaps the
 * dialog for the item's once the forge has answered, and returns false when it
 * has not, so the click follows the link to the forge.
 */
export type UntrackedMention = {
  warm: (issue: MentionedIssue) => void;
  open: (issue: MentionedIssue) => boolean;
};

/** What the pill shows: the number, with the whole repo when it is not the pull request's. */
export function mentionPillText(issue: MentionedIssue, prRepo: string) {
  return `Mentions ${issueNumber(issue, prRepo)}`;
}

/** The pill's tooltip: the item's title and what the pull request does to it. Nothing without a title, as before. */
export const mentionPillTitle = (issue: MentionedIssue) =>
  hasPillTitle(issue.title)
    ? pillHoverText(issue.title, 'Mentioned here, does not close it')
    : undefined;

/** The pill's accessible name. It contains the visible text (WCAG 2.5.3). */
export function mentionPillName(issue: MentionedIssue, prRepo: string) {
  const where = issue.tracked ? 'opens the issue' : 'opens on the forge';
  return `${mentionPillText(issue, prRepo)}, ${where}`;
}

/** The pill's accessible name in the Related band: the relation first, then the number it contains and where the pill goes. */
export function mentionDialogName(issue: MentionedIssue, prRepo: string) {
  const where = issue.tracked ? 'opens the issue' : 'opens on the forge';
  return `Mentions: ${issueNumber(issue, prRepo)}, ${where}`;
}

/**
 * The pills for one pull request, drawn like the closing ones: the first two,
 * then a count that opens the rest in place. Null when it mentions nothing, so
 * no empty section is left behind. A ticket the dashboard does not track opens
 * on the forge in a new tab. With onFollow, a plain click on a tracked one hands
 * it over so the dialog can be swapped for the issue's. With untracked, a plain
 * click on an untracked one opens it in the dialog when the forge can show it.
 */
export function mentionPills(
  prKey: string,
  prRepo: string,
  list: MentionedIssue[] | undefined,
  onFollow?: (issue: MentionedIssue) => void,
  inDialog = false,
  untracked?: UntrackedMention,
): HTMLElement | null {
  if (!list || list.length === 0) return null;
  const wrap = document.createElement('span');
  wrap.className = 'linked-prs';
  const pill = (issue: MentionedIssue) => {
    const link = document.createElement('a');
    link.className = 'linked-pr mention-pill';
    link.href = issue.tracked ? issue.pageUrl : issue.url;
    if (issue.tracked && onFollow)
      link.addEventListener('click', (event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onFollow(issue);
      });
    if (!issue.tracked) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (untracked) followUntracked(link, issue, untracked);
    }
    if (inDialog) {
      const number = issueNumber(issue, prRepo);
      if (
        !appendRepoRef(link, issue.repo, issue.number, number.startsWith('#'))
      )
        link.textContent = number;
      link.setAttribute('aria-label', mentionDialogName(issue, prRepo));
    } else {
      link.textContent = mentionPillText(issue, prRepo);
      link.setAttribute('aria-label', mentionPillName(issue, prRepo));
    }
    const hover = mentionPillTitle(issue);
    if (hover === undefined) return link;
    link.title = hover;
    return addPillTip(link, hover);
  };
  if (inDialog)
    return foldedPills(
      `${prKey}:mentions`,
      list,
      pill,
      'issues that this pull request mentions',
    );
  const { shown, rest } = splitClosing(list);
  wrap.append(...shown.map(pill));
  if (rest.length === 0) return wrap;

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'linked-pr-more';
  more.textContent = `${rest.length} more`;
  more.setAttribute(
    'aria-label',
    `${rest.length} more issues that this pull request mentions`,
  );
  const reveal = () => {
    const extra = rest.map(pill);
    more.replaceWith(...extra);
    expanded.add(prKey);
    return extra;
  };
  more.addEventListener('click', () => focusPill(reveal()[0]));
  wrap.append(more);
  if (expanded.has(prKey)) reveal();
  return wrap;
}

/** Warms the forge's answer on rest, focus and press, and opens the dialog on a plain click once it is in. */
function followUntracked(
  link: HTMLAnchorElement,
  issue: MentionedIssue,
  untracked: UntrackedMention,
) {
  const dwell = createDwell(() => untracked.warm(issue));
  // The prefetcher keeps one lookup per item, so a dwell that fires after this
  // asks nothing more.
  const warmNow = () => untracked.warm(issue);
  link.addEventListener('pointerover', () => dwell.rest(link, undefined));
  link.addEventListener('pointerout', () => dwell.cancel());
  link.addEventListener('pointerdown', warmNow);
  link.addEventListener('focus', warmNow);
  link.addEventListener('click', (event) => {
    if (!isPlainClick(event)) return;
    if (untracked.open(issue)) event.preventDefault();
  });
}
