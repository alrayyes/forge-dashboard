import { isKnownForge } from './forges';
import {
  addPillTip,
  focusPill,
  hasPillTitle,
  pillHoverText,
} from './pill-tip.js';
import { isPlainClick } from './plain-click.js';
import { appendRepoRef, foldedPills } from './related-band.js';

// The pills on a pull request that link to the issues it will close, and the
// address that opens one of them on the Issues page. The server decides which
// issues those are and builds each address; this only words them and reads
// the address back. The mirror of linked-pull-requests.ts, which does the same
// from an issue to its pull requests.

/** Matches components.schemas.ClosingIssue in api/openapi.yaml. */
export type ClosingIssue = {
  repo: string;
  number: number;
  url: string;
  pageUrl: string;
  /** How the pull request relates to the issue; closes when the server sent none. */
  relation?: 'closes' | 'refs' | 'mentions';
  /** The issue's title when the dashboard holds it, for the pill's hover text. */
  title?: string;
};

/** How many pills a row shows before the rest wait behind a count. */
export const SHOWN_PILLS = 2;

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The number as a pill writes it: bare in the pull request's repo, else with the repo. */
export const issueNumber = (issue: ClosingIssue, prRepo: string) =>
  sameRepo(issue.repo, prRepo)
    ? `#${issue.number}`
    : `${issue.repo}#${issue.number}`;

/** What the pill shows: the relation, then the number, with the whole repo when it is not the pull request's. */
export function closingPillText(issue: ClosingIssue, prRepo: string) {
  const word = issue.relation === 'refs' ? 'Refs' : 'Closes';
  return `${word} ${issueNumber(issue, prRepo)}`;
}

/** What the pill shows in the Related band: the bare number, with the repo when it is not the pull request's. The row label says the relation. */
export const closingDialogText = (issue: ClosingIssue, prRepo: string) =>
  issueNumber(issue, prRepo);

/** The pill's accessible name in the band: the relation first, then the number it contains and where the pill goes. */
export function closingDialogName(
  issue: ClosingIssue,
  prRepo: string,
  external = false,
) {
  const number = issueNumber(issue, prRepo);
  const where = external
    ? 'opens on the forge in a new tab'
    : 'opens the issue';
  return issue.relation === 'refs'
    ? `Refs: ${number}, does not close, ${where}`
    : `Closes: ${number}, ${where}`;
}

/** The pill's class: a refs pill is drawn apart from a closes one. */
export const closingPillClass = (issue: ClosingIssue) =>
  issue.relation === 'refs'
    ? 'linked-pr refs-issue'
    : 'linked-pr closing-issue';

/** The pill's accessible name. It contains the visible text (WCAG 2.5.3). */
export function closingPillName(issue: ClosingIssue, prRepo: string) {
  const text = closingPillText(issue, prRepo);
  return issue.relation === 'refs'
    ? `${text}, references, does not close, opens the issue`
    : `${text}, opens the issue`;
}

/** The pill's tooltip: the issue's title when known, then what the pill does to it, which the italic alone doesn't say. */
export const closingPillTitle = (issue: ClosingIssue) =>
  pillHoverText(
    issue.title,
    issue.relation === 'refs'
      ? 'References the issue, does not close it'
      : 'Closes the issue when it merges',
  );

/** The pills a row shows, and the ones kept behind the count. */
export function splitClosing<T extends ClosingIssue>(list: T[]) {
  return { shown: list.slice(0, SHOWN_PILLS), rest: list.slice(SHOWN_PILLS) };
}

export type IssueAddress = {
  forge: string;
  repo: string;
  number: number;
};

/**
 * Reads `?issue=forge/owner/name/number`, the form the server writes. Null for
 * a missing or malformed one, so a stray value opens nothing.
 */
export function parseIssueAddress(search: string): IssueAddress | null {
  const value = new URLSearchParams(search).get('issue');
  if (!value) return null;
  const parts = value.split('/');
  if (parts.length !== 4) return null;
  const [forge, owner, name, raw] = parts;
  if (!isKnownForge(forge) || !owner || !name || !/^[0-9]+$/.test(raw))
    return null;
  const number = Number(raw);
  if (number < 1) return null;
  return { forge, repo: `${owner}/${name}`, number };
}

/**
 * The listed issue an address names, or undefined. The repo matches ignoring
 * case: Forgejo's closing references are lowercased, the issue's repo is not.
 */
export function findAddressedIssue<
  T extends { forge: string; repo: string; number: number },
>(listed: T[], wanted: IssueAddress): T | undefined {
  return listed.find(
    (i) =>
      i.forge === wanted.forge &&
      i.number === wanted.number &&
      sameRepo(i.repo, wanted.repo),
  );
}

/**
 * The plain note for an address whose issue is not on the board: it was
 * closed since the link was made, the dashboard does not track its repo, or
 * the settings hide it.
 */
export function missingIssueNote(ref: IssueAddress) {
  return `Issue ${ref.repo} #${ref.number} is not open any more, is hidden by your settings, or this dashboard does not track it.`;
}

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Pull requests whose hidden pills the reader opened, so a redrawn row keeps them open. */
const expanded = new Set<string>();

/** A pill's id: stable across redraws, so a closed dialog finds it again. */
export const closingPillId = (prKey: string, issue: ClosingIssue) =>
  `closing-pill-${issue.relation ?? 'closes'}-${prKey}-${issue.repo}-${issue.number}`.replace(
    /[^A-Za-z0-9_-]/g,
    '-',
  );

/**
 * The pills for one pull request: the first two, then a count that opens the
 * rest in place. Null when it closes nothing. With onOpen, each pill is a
 * button that opens that issue's dialog where the reader is, and hands over
 * the pill's id so focus can return to it. Without it, the pill is a link to
 * the Issues page with that issue's pop-up open. With onFollow instead, inside
 * a dialog, a plain click on that link hands the issue over so the dialog can
 * be swapped for the issue's. With inDialog, the pills are the Related band's:
 * bare numbers, names that lead with the relation, and the band's own fold.
 * With untrackedRepo, a pill in a dialog whose repository it says the
 * dashboard does not track is a link to the forge in a new tab instead, so a
 * click leaves the dialog open (#4461).
 */
export function closingPills(
  prKey: string,
  prRepo: string,
  list: ClosingIssue[] | undefined,
  onOpen?: (issue: ClosingIssue, triggerId: string) => void,
  onFollow?: (issue: ClosingIssue) => void,
  inDialog = false,
  untrackedRepo?: (repo: string) => boolean,
): HTMLElement | null {
  if (!list || list.length === 0) return null;
  const { shown, rest } = splitClosing(list);
  const wrap = element('span', 'linked-prs');
  const pill = (issue: ClosingIssue) => {
    const link = element(
      onOpen !== undefined ? 'button' : 'a',
      closingPillClass(issue),
    );
    const external = inDialog && untrackedRepo?.(issue.repo) === true;
    if (link instanceof HTMLAnchorElement && external) {
      link.href = issue.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else if (link instanceof HTMLAnchorElement) {
      link.href = issue.pageUrl;
      // Inside a dialog: a plain click swaps it for the issue's, the address
      // stays a real link for a new tab.
      if (onFollow)
        link.addEventListener('click', (event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onFollow(issue);
        });
    }
    if (link instanceof HTMLButtonElement && onOpen) {
      link.type = 'button';
      link.id = closingPillId(prKey, issue);
      link.addEventListener('click', () => onOpen(issue, link.id));
    }
    if (inDialog) {
      const bare = sameRepo(issue.repo, prRepo);
      if (!appendRepoRef(link, issue.repo, issue.number, bare))
        link.textContent = closingDialogText(issue, prRepo);
      link.setAttribute(
        'aria-label',
        closingDialogName(issue, prRepo, external),
      );
    } else {
      link.textContent = closingPillText(issue, prRepo);
      link.setAttribute('aria-label', closingPillName(issue, prRepo));
    }
    link.title = closingPillTitle(issue);
    return issue.relation === 'refs' || hasPillTitle(issue.title)
      ? addPillTip(link, closingPillTitle(issue))
      : link;
  };
  if (inDialog)
    return foldedPills(
      `${prKey}:closing:${list[0]?.relation ?? 'closes'}`,
      list,
      pill,
      `issues that this pull request ${list[0]?.relation === 'refs' ? 'references' : 'will close'}`,
    );
  wrap.append(...shown.map(pill));
  if (rest.length === 0) return wrap;

  const more = element('button', 'linked-pr-more', `${rest.length} more`);
  more.type = 'button';
  more.setAttribute(
    'aria-label',
    `${rest.length} more issues that this pull request ${list[0]?.relation === 'refs' ? 'references' : 'will close'}`,
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
