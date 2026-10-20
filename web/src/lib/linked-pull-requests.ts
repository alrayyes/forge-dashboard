// The pills on an issue row that link to the pull requests which will close
// it, and the address that opens one of them on its page (#2082). The server
// decides which pull requests those are and builds each address; this only
// words them and reads the address back.

/** Matches components.schemas.LinkedPullRequest in api/openapi.yaml. */
export type LinkedPullRequest = {
  forge: string;
  repo: string;
  number: number;
  draft: boolean;
  pageUrl: string;
};

/** How many pills a row shows before the rest wait behind a count. */
export const SHOWN_PILLS = 2;

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const stateOf = (pr: LinkedPullRequest) => (pr.draft ? 'draft' : 'open');

const numberOf = (pr: LinkedPullRequest, issueRepo: string, whole: boolean) => {
  if (sameRepo(pr.repo, issueRepo)) return `#${pr.number}`;
  return `${whole ? pr.repo : (pr.repo.split('/').pop() ?? pr.repo)}#${pr.number}`;
};

/** What the pill shows: the number and the state, with the repo when it is not the issue's. */
export function linkedPillText(pr: LinkedPullRequest, issueRepo: string) {
  return `${numberOf(pr, issueRepo, false)} ${stateOf(pr)}`;
}

/** The pill's accessible name. It contains the visible text (WCAG 2.5.3). */
export function linkedPillName(pr: LinkedPullRequest, issueRepo: string) {
  return `Pull request ${numberOf(pr, issueRepo, true)} ${stateOf(pr)}, closes this issue`;
}

/** The pills a row shows, and the ones kept behind the count. */
export function splitLinked(list: LinkedPullRequest[]) {
  return { shown: list.slice(0, SHOWN_PILLS), rest: list.slice(SHOWN_PILLS) };
}

export type PullRequestAddress = {
  forge: string;
  repo: string;
  number: number;
};

const FORGES = new Set(['github', 'forgejo']);

/**
 * Reads `?pr=forge/owner/name/number`, the form the server writes. Null for a
 * missing or malformed one, so a stray value opens nothing.
 */
export function parsePullRequestAddress(
  search: string,
): PullRequestAddress | null {
  const value = new URLSearchParams(search).get('pr');
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
 * The plain note for an address whose pull request is nowhere to be found,
 * even with drafts and hidden ones asked for: it merged or closed since the
 * link was made, or the dashboard does not track its repo.
 */
export function missingNote(ref: PullRequestAddress) {
  return `Pull request ${ref.repo} #${ref.number} is not open any more, or this dashboard does not track it.`;
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

/** Issues whose hidden pills the reader opened, so a redrawn row keeps them open. */
const expanded = new Set<string>();

/**
 * The pills for one issue row: the first two, then a count that opens the
 * rest in place. Null when no pull request will close the issue. Each pill is
 * a plain link to the pull request page with its pop-up open.
 */
export function linkedPills(
  issueKey: string,
  issueRepo: string,
  list: LinkedPullRequest[] | undefined,
): HTMLElement | null {
  if (!list || list.length === 0) return null;
  const { shown, rest } = splitLinked(list);
  const wrap = element('span', 'linked-prs');
  const pill = (pr: LinkedPullRequest) => {
    const link = element('a', pr.draft ? 'linked-pr draft' : 'linked-pr');
    link.href = pr.pageUrl;
    link.textContent = linkedPillText(pr, issueRepo);
    link.setAttribute('aria-label', linkedPillName(pr, issueRepo));
    return link;
  };
  wrap.append(...shown.map(pill));
  if (rest.length === 0) return wrap;

  const more = element('button', 'linked-pr-more', `${rest.length} more`);
  more.type = 'button';
  more.setAttribute(
    'aria-label',
    `${rest.length} more pull requests that will close this issue`,
  );
  const reveal = () => {
    const extra = rest.map(pill);
    more.replaceWith(...extra);
    expanded.add(issueKey);
    return extra;
  };
  more.addEventListener('click', () => reveal()[0]?.focus());
  wrap.append(more);
  if (expanded.has(issueKey)) reveal();
  return wrap;
}
