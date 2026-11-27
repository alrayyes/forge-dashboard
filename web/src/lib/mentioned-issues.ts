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
 * How a pill for an item the dashboard does not hold reaches the details
 * dialog. In a repository the dashboard tracks (`repoTracked`), `open` always
 * swaps the dialog, which does its own read (#5089), and `warm` only reads
 * ahead. Elsewhere (#4321, like a mention in the description, #4269) `open`
 * swaps the dialog only once `warm` has had the forge's answer. It returns
 * false when it has not, so the click follows the link to the forge.
 */
export type UntrackedMention = {
  repoTracked: (repo: string) => boolean;
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

// Where a click goes. An unlisted item of a tracked repository may be a closed
// issue or a pull request, so its name says neither.
function destination(issue: MentionedIssue, repoTracked: boolean) {
  if (issue.tracked) return 'opens the issue';
  return repoTracked ? 'opens its details' : 'opens on the forge';
}

/** The pill's accessible name. It contains the visible text (WCAG 2.5.3). */
export function mentionPillName(
  issue: MentionedIssue,
  prRepo: string,
  repoTracked = false,
) {
  return `${mentionPillText(issue, prRepo)}, ${destination(issue, repoTracked)}`;
}

/** The pill's accessible name in the Related band: the relation first, then the number it contains and where the pill goes. */
export function mentionDialogName(
  issue: MentionedIssue,
  prRepo: string,
  repoTracked = false,
) {
  return `Mentions: ${issueNumber(issue, prRepo)}, ${destination(issue, repoTracked)}`;
}

/**
 * The pills for one pull request, drawn like the closing ones: the first two,
 * then a count that opens the rest in place. Null when it mentions nothing, so
 * no empty section is left behind. A ticket the dashboard does not hold is a
 * link to the forge in a new tab. With onFollow, a plain click on a held one
 * hands it over so the dialog can be swapped for the issue's. With untracked, a
 * plain click on one it does not hold opens it in the dialog: always when the
 * repository is tracked, else once the forge has shown it. A middle or modified
 * click follows the link either way.
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
    const repoTracked =
      !issue.tracked && untracked?.repoTracked(issue.repo) === true;
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
      if (untracked) {
        warmUntracked(link, issue, untracked, repoTracked);
        link.addEventListener('click', (event) => {
          if (!isPlainClick(event)) return;
          if (untracked.open(issue)) event.preventDefault();
        });
      }
    }
    if (inDialog) {
      const number = issueNumber(issue, prRepo);
      if (
        !appendRepoRef(link, issue.repo, issue.number, number.startsWith('#'))
      )
        link.textContent = number;
      link.setAttribute(
        'aria-label',
        mentionDialogName(issue, prRepo, repoTracked),
      );
    } else {
      link.textContent = mentionPillText(issue, prRepo);
      link.setAttribute(
        'aria-label',
        mentionPillName(issue, prRepo, repoTracked),
      );
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

/**
 * Reads ahead of a click. An untracked repository's pill needs the answer to
 * open the dialog at all, so a press and any focus ask too. A tracked one's
 * dialog opens at once and reads for itself (#5089), so only a resting pointer
 * or keyboard focus asks, which lets it open already filled (#4411).
 */
function warmUntracked(
  link: HTMLAnchorElement,
  issue: MentionedIssue,
  untracked: UntrackedMention,
  repoTracked: boolean,
) {
  const dwell = createDwell(() => untracked.warm(issue));
  // The prefetcher keeps one lookup per item, so a dwell that fires after this
  // asks nothing more.
  const warmNow = () => untracked.warm(issue);
  link.addEventListener('pointerover', () => dwell.rest(link, undefined));
  link.addEventListener('pointerout', () => dwell.cancel());
  if (!repoTracked) link.addEventListener('pointerdown', warmNow);
  link.addEventListener('focus', () => {
    if (!repoTracked || link.matches(':focus-visible')) warmNow();
  });
}
