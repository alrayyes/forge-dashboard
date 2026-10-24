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

/** Pull requests whose folded mentions the reader opened, so a redraw keeps them open. */
const expanded = new Set<string>();

/** Matches components.schemas.MentionedIssue in api/openapi.yaml. */
export type MentionedIssue = ClosingIssue & { tracked: boolean };

/** What the pill shows: the number, with the whole repo when it is not the pull request's. */
export function mentionPillText(issue: MentionedIssue, prRepo: string) {
  return `Mentions ${issueNumber(issue, prRepo)}`;
}

/** The pill's accessible name. It contains the visible text (WCAG 2.5.3). */
export function mentionPillName(issue: MentionedIssue, prRepo: string) {
  const where = issue.tracked ? 'opens the issue' : 'opens on the forge';
  return `${mentionPillText(issue, prRepo)}, ${where}`;
}

/**
 * The pills for one pull request, drawn like the closing ones: the first two,
 * then a count that opens the rest in place. Null when it mentions nothing, so
 * no empty section is left behind. A ticket the dashboard does not track opens
 * on the forge in a new tab.
 */
export function mentionPills(
  prKey: string,
  prRepo: string,
  list: MentionedIssue[] | undefined,
): HTMLElement | null {
  if (!list || list.length === 0) return null;
  const wrap = document.createElement('span');
  wrap.className = 'linked-prs';
  const pill = (issue: MentionedIssue) => {
    const link = document.createElement('a');
    link.className = 'linked-pr mention-pill';
    link.href = issue.tracked ? issue.pageUrl : issue.url;
    if (!issue.tracked) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    link.textContent = mentionPillText(issue, prRepo);
    link.setAttribute('aria-label', mentionPillName(issue, prRepo));
    return link;
  };
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
  more.addEventListener('click', () => reveal()[0]?.focus());
  wrap.append(more);
  if (expanded.has(prKey)) reveal();
  return wrap;
}
