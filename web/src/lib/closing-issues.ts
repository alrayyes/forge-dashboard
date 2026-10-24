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
};

/** How many pills a row shows before the rest wait behind a count. */
export const SHOWN_PILLS = 2;

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The number as a pill writes it: bare in the pull request's repo, else with the repo. */
export const issueNumber = (issue: ClosingIssue, prRepo: string) =>
  sameRepo(issue.repo, prRepo)
    ? `#${issue.number}`
    : `${issue.repo}#${issue.number}`;

/** What the pill shows: the number, with the whole repo when it is not the pull request's. */
export function closingPillText(issue: ClosingIssue, prRepo: string) {
  return `Closes ${issueNumber(issue, prRepo)}`;
}

/** The pill's accessible name. It contains the visible text (WCAG 2.5.3). */
export function closingPillName(issue: ClosingIssue, prRepo: string) {
  return `${closingPillText(issue, prRepo)}, opens the issue`;
}

/** The pills a row shows, and the ones kept behind the count. */
export function splitClosing<T extends ClosingIssue>(list: T[]) {
  return { shown: list.slice(0, SHOWN_PILLS), rest: list.slice(SHOWN_PILLS) };
}

export type IssueAddress = {
  forge: string;
  repo: string;
  number: number;
};

const FORGES = new Set(['github', 'forgejo']);

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
  if (!FORGES.has(forge) || !owner || !name || !/^[0-9]+$/.test(raw))
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
  `closing-pill-${prKey}-${issue.repo}-${issue.number}`.replace(
    /[^A-Za-z0-9_-]/g,
    '-',
  );

/**
 * The pills for one pull request: the first two, then a count that opens the
 * rest in place. Null when it closes nothing. With onOpen, each pill is a
 * button that opens that issue's dialog where the reader is, and hands over
 * the pill's id so focus can return to it. Without it, the pill is a link to
 * the Issues page with that issue's pop-up open (inside a dialog, where a
 * second one would stack).
 */
export function closingPills(
  prKey: string,
  prRepo: string,
  list: ClosingIssue[] | undefined,
  onOpen?: (issue: ClosingIssue, triggerId: string) => void,
): HTMLElement | null {
  if (!list || list.length === 0) return null;
  const { shown, rest } = splitClosing(list);
  const wrap = element('span', 'linked-prs');
  const pill = (issue: ClosingIssue) => {
    const link = element(
      onOpen !== undefined ? 'button' : 'a',
      'linked-pr closing-issue',
    );
    if (link instanceof HTMLAnchorElement) link.href = issue.pageUrl;
    if (link instanceof HTMLButtonElement && onOpen) {
      link.type = 'button';
      link.id = closingPillId(prKey, issue);
      link.addEventListener('click', () => onOpen(issue, link.id));
    }
    link.textContent = closingPillText(issue, prRepo);
    link.setAttribute('aria-label', closingPillName(issue, prRepo));
    return link;
  };
  wrap.append(...shown.map(pill));
  if (rest.length === 0) return wrap;

  const more = element('button', 'linked-pr-more', `${rest.length} more`);
  more.type = 'button';
  more.setAttribute(
    'aria-label',
    `${rest.length} more issues that this pull request will close`,
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
