// The pills on an issue row that link to the pull requests which will close
// it, and the address that opens one of them on its page (#2082). The server
// decides which pull requests those are and builds each address; this only
// words them and reads the address back.

import {
  type CheckCounts,
  type CheckSegment,
  pillName,
} from './check-counts.js';

/** Matches components.schemas.LinkedPullRequest in api/openapi.yaml. */
export type LinkedPullRequest = {
  forge: string;
  repo: string;
  number: number;
  draft: boolean;
  pageUrl: string;
  ci: string;
  checks: CheckCounts;
  awaitingWorkflowApproval: boolean;
};

/**
 * The pipeline a pill carries, drawn by the same code as the pull request's own
 * row: the node to show, and the word and counts it says, so the pill's text
 * and name can contain them whole.
 */
export type PillCi = {
  badge: HTMLElement;
  label: string;
  segments: CheckSegment[];
};

/** Draws a linked pull request's pipeline, or null when it has none to show. */
export type PillCiRenderer = (pr: LinkedPullRequest) => PillCi | null;

/** How many pills a row shows before the rest wait behind a count. */
export const SHOWN_PILLS = 2;

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const stateOf = (pr: LinkedPullRequest) => (pr.draft ? 'draft' : 'open');

const numberOf = (pr: LinkedPullRequest, issueRepo: string) =>
  sameRepo(pr.repo, issueRepo) ? `#${pr.number}` : `${pr.repo}#${pr.number}`;

/** The words of a pipeline as the pill's text reads them: "Running 3 2 1". */
const ciText = (ci: PillCi) =>
  [ci.label, ...ci.segments.map((s) => String(s.n))].join(' ');

/**
 * What the pill shows: the number and the state, with the whole repo when it is
 * not the issue's, then the pipeline's word and counts when it has any.
 */
export function linkedPillText(
  pr: LinkedPullRequest,
  issueRepo: string,
  ci?: PillCi | null,
) {
  const head = `${numberOf(pr, issueRepo)} ${stateOf(pr)}`;
  return ci ? `${head} ${ciText(ci)}` : head;
}

/**
 * The pill's accessible name. It contains the visible text (WCAG 2.5.3), with
 * each count said in words after it.
 */
export function linkedPillName(
  pr: LinkedPullRequest,
  issueRepo: string,
  ci?: PillCi | null,
) {
  const head = `${numberOf(pr, issueRepo)} ${stateOf(pr)}`;
  if (!ci) return `Pull request ${head}, closes this issue`;
  const said =
    ci.segments.length > 0 ? pillName(ci.label, ci.segments) : ci.label;
  return `Pull request ${head} ${said}, closes this issue`;
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

/** A pill's id: stable across redraws, so a closed dialog finds it again. */
export const linkedPillId = (issueKey: string, pr: LinkedPullRequest) =>
  `linked-pill-${issueKey}-${pr.forge}-${pr.repo}-${pr.number}`.replace(
    /[^A-Za-z0-9_-]/g,
    '-',
  );

/**
 * The pills for one issue row: the first two, then a count that opens the
 * rest in place. Null when no pull request will close the issue. With onOpen,
 * each pill is a button that opens that pull request's dialog where the
 * reader is, and hands over the pill's id so focus can return to it. Without
 * it, the pill is a link to the pull request page with its pop-up open.
 * With renderCi, a pill whose pull request has a pipeline carries it.
 */
export function linkedPills(
  issueKey: string,
  issueRepo: string,
  list: LinkedPullRequest[] | undefined,
  onOpen?: (pr: LinkedPullRequest, triggerId: string) => void,
  renderCi?: PillCiRenderer,
): HTMLElement | null {
  if (!list || list.length === 0) return null;
  const { shown, rest } = splitLinked(list);
  const wrap = element('span', 'linked-prs');
  const pill = (pr: LinkedPullRequest) => {
    const link = element(
      onOpen !== undefined ? 'button' : 'a',
      ['linked-pr', pr.draft ? 'draft' : ''].filter(Boolean).join(' '),
    );
    if (link instanceof HTMLAnchorElement) link.href = pr.pageUrl;
    if (link instanceof HTMLButtonElement && onOpen) {
      link.type = 'button';
      link.id = linkedPillId(issueKey, pr);
      link.addEventListener('click', () => onOpen(pr, link.id));
    }
    const ci: PillCi | null = renderCi ? renderCi(pr) : null;
    // A cross-repo repo name is its own node so it alone can be cut short with
    // an ellipsis: the number, the state and the pipeline stay whole, and two
    // pills from one long repo stay apart. The text and the accessible name
    // still carry the whole name.
    const text = linkedPillText(pr, issueRepo);
    const ref = numberOf(pr, issueRepo);
    const number = `#${pr.number}`;
    if (text.startsWith(ref) && ref.length > number.length) {
      const refNode = element('span', 'linked-pr-ref');
      const repoNode = element('span', 'linked-pr-repo', pr.repo);
      repoNode.title = pr.repo;
      refNode.append(repoNode, element('span', 'linked-pr-number', number));
      link.append(refNode, text.slice(ref.length));
    } else {
      link.textContent = text;
    }
    if (ci) {
      // The badge follows the number, with the space the text reads across.
      link.append(' ', ci.badge);
      link.classList.add('with-ci');
    }
    link.setAttribute('aria-label', linkedPillName(pr, issueRepo, ci));
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
