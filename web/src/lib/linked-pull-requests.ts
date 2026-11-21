// The pills on an issue row that link to the pull requests which will close
// it, and the address that opens one of them on its page (#2082). The server
// decides which pull requests those are and builds each address; this only
// words them and reads the address back.

import {
  type CheckCounts,
  type CheckSegment,
  pillName,
} from './check-counts.js';
import { isKnownForge } from './forges';
import {
  addPillTip,
  focusPill,
  hasPillTitle,
  pillHoverText,
} from './pill-tip.js';
import { isPlainClick } from './plain-click.js';
import {
  foldedPills,
  type RelatedSide,
  relationLabel,
} from './related-band.js';

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
  /** The item's title when the server holds it, for the pill's hover text. */
  title?: string;
  /**
   * Set only on an entry that came from an issue's own details (#4271), where
   * the item may be an issue, or a pull request that is closed or merged. The
   * board's pills are always open pull requests and leave all three out.
   */
  kind?: 'issue' | 'pullRequest';
  state?: 'open' | 'closed' | 'merged';
  url?: string;
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

// The board's linked pull requests are all open, so only a draft says its
// state. One read from an issue's details says closed or merged as well.
const stateOf = (pr: LinkedPullRequest) =>
  pr.draft ? ' draft' : pr.state && pr.state !== 'open' ? ` ${pr.state}` : '';

// An entry from an issue's details says its state as a word after the number
// ("PR #12 · Merged"), so a pill under "Closed by" doesn't read as if it closes
// something itself (#4283). The pills on a board row carry no state and keep
// the shorter form; the Related band gives them one with withBoardState.
const stated = (pr: LinkedPullRequest) =>
  pr.kind === 'pullRequest' && pr.state !== undefined;

// A closed or merged pull request says so even when it was a draft.
const stateWord = (pr: LinkedPullRequest) => {
  const state = pr.state ?? 'open';
  if (state === 'open') return pr.draft ? 'Draft' : 'Open';
  return `${state[0].toUpperCase()}${state.slice(1)}`;
};

/**
 * The board's pills are all open pull requests, so the Related band can say
 * so: the same entries as an issue's own details give, with a state.
 */
export const withBoardState = (
  list: LinkedPullRequest[] | undefined,
): LinkedPullRequest[] | undefined =>
  list?.map((pr) => ({
    ...pr,
    kind: pr.kind ?? 'pullRequest',
    state: pr.state ?? 'open',
  }));

const nounOf = (pr: LinkedPullRequest) =>
  pr.kind === 'issue' ? 'Issue' : 'Pull request';

// The rest of the pill's text after the number. A merged pull request's word
// is its own node so it takes the Merged colour (#4406); the text is the same.
const MERGED_WORD = 'Merged';
function appendTail(link: HTMLElement, tail: string, pr: LinkedPullRequest) {
  if (stated(pr) && pr.state === 'merged' && tail.endsWith(MERGED_WORD)) {
    link.append(
      tail.slice(0, -MERGED_WORD.length),
      element('span', 'linked-pr-merged', MERGED_WORD),
    );
  } else {
    link.append(tail);
  }
}

/** The number and state as the pill reads them, with no pipeline. */
const headOf = (pr: LinkedPullRequest, issueRepo: string) =>
  stated(pr)
    ? `PR ${numberOf(pr, issueRepo)} · ${stateWord(pr)}`
    : `${numberOf(pr, issueRepo)}${stateOf(pr)}`;

const numberOf = (pr: LinkedPullRequest, issueRepo: string) =>
  sameRepo(pr.repo, issueRepo) ? `#${pr.number}` : `${pr.repo}#${pr.number}`;

/** The words of a pipeline as the pill's text reads them: "Running 3 2 1". */
const ciText = (ci: PillCi) =>
  [ci.label, ...ci.segments.map((s) => String(s.n))].join(' ');

/**
 * What the pill shows: the number, and "draft" for a draft, with the whole repo
 * when it is not the issue's, then the pipeline's word and counts when it has any.
 */
export function linkedPillText(
  pr: LinkedPullRequest,
  issueRepo: string,
  ci?: PillCi | null,
) {
  const head = headOf(pr, issueRepo);
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
  relation: Relation = 'closes',
) {
  const head = headOf(pr, issueRepo);
  const says = relation === 'refs' ? 'references, does not close' : relation;
  const noun = stated(pr) ? '' : `${nounOf(pr)} `;
  if (!ci) return `${noun}${head}, ${says} this issue`;
  const said =
    ci.segments.length > 0 ? pillName(ci.label, ci.segments) : ci.label;
  return `${noun}${head} ${said}, ${says} this issue`;
}

/** What a pull request does to the issue its pill sits on. */
export type Relation = 'closes' | 'refs' | 'mentions';

/**
 * The pill's accessible name in the Related band: the row's relation first,
 * then the words the row's pill says, with no relation after them. One form
 * for every pill in the band (#4220).
 */
export function linkedDialogName(
  pr: LinkedPullRequest,
  issueRepo: string,
  ci?: PillCi | null,
  relation: Relation = 'closes',
  side: RelatedSide = 'issue',
  external = false,
) {
  const head = stated(pr)
    ? headOf(pr, issueRepo)
    : `${nounOf(pr)} ${numberOf(pr, issueRepo)}${stateOf(pr)}`;
  const said = ci
    ? ci.segments.length > 0
      ? pillName(ci.label, ci.segments)
      : ci.label
    : '';
  const name = `${relationLabel(side, relation)}: ${said ? `${head} ${said}` : head}`;
  return external ? `${name}, opens on the forge in a new tab` : name;
}

/** The pill's classes: a ref and a mention are each drawn apart from a close. */
export function linkedPillClass(pr: LinkedPullRequest, relation: Relation) {
  return [
    'linked-pr',
    pr.draft ? 'draft' : '',
    relation === 'mentions' ? 'mention-pill' : '',
    relation === 'refs' ? 'refs-pill' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The pill's tooltip: the item's title when known, then what it does to the issue, which the italic alone doesn't say. */
export function linkedPillTitle(
  relation: Relation,
  side: RelatedSide = 'issue',
  title?: string,
) {
  return pillHoverText(title, linkedPillLine(relation, side));
}

function linkedPillLine(relation: Relation, side: RelatedSide) {
  if (side === 'issue-outgoing')
    return relation === 'refs'
      ? 'This issue references this, it does not close it'
      : `This issue ${relation === 'closes' ? 'closes' : 'mentions'} this`;
  if (relation === 'closes') return 'Closes this issue when it merges';
  const verb = relation === 'refs' ? 'References' : 'Mentions';
  return `${verb} this issue, does not close it`;
}

const OUTGOING_WORDING: Record<Relation, string> = {
  closes: 'this issue closes',
  refs: 'this issue references',
  mentions: 'this issue mentions',
};

const MORE_WORDING: Record<Relation, string> = {
  closes: 'will close',
  refs: 'reference',
  mentions: 'mention',
};

/** The accessible name of the count that opens the pills kept back. */
export function linkedMoreName(count: number, relation: Relation) {
  return `${count} more pull requests that ${MORE_WORDING[relation]} this issue`;
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
  if (!isKnownForge(forge) || !owner || !name || !/^[0-9]+$/.test(raw))
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
 * it, the pill is a link to the pull request page with its pop-up open; with
 * onFollow too, a plain click on that link calls it instead of leaving the page.
 * With renderCi, a pill whose pull request has a pipeline carries it. With
 * inDialog, the pills are the Related band's: names that lead with the
 * relation, and the band's own fold. With untrackedRepo, a pill in a dialog
 * for a pull request in a repository the dashboard does not track, and that
 * carries its forge address, is a link to the forge in a new tab instead, so a
 * click leaves the dialog open (#4461).
 */
export function linkedPills(
  issueKey: string,
  issueRepo: string,
  list: LinkedPullRequest[] | undefined,
  onOpen?: (pr: LinkedPullRequest, triggerId: string) => void,
  renderCi?: PillCiRenderer,
  onFollow?: (pr: LinkedPullRequest) => void,
  relation: Relation = 'closes',
  inDialog = false,
  side: RelatedSide = 'issue',
  untrackedRepo?: (forge: string, repo: string) => boolean,
): HTMLElement | null {
  if (!list || list.length === 0) return null;
  const { shown, rest } = splitLinked(list);
  const wrap = element('span', 'linked-prs');
  const pill = (pr: LinkedPullRequest) => {
    const link = element(
      onOpen !== undefined ? 'button' : 'a',
      linkedPillClass(pr, relation),
    );
    const forgeUrl =
      inDialog && pr.kind !== 'issue' && untrackedRepo?.(pr.forge, pr.repo)
        ? pr.url
        : undefined;
    const external = !!forgeUrl;
    if (link instanceof HTMLAnchorElement && forgeUrl) {
      link.href = forgeUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else if (link instanceof HTMLAnchorElement) {
      link.href = pr.pageUrl;
      // A plain click opens the dialog where the reader is; the address stays
      // a real link, so a middle or modified click opens it in a new tab.
      if (onFollow)
        link.addEventListener('click', (event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onFollow(pr);
        });
    }
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
    const at = text.indexOf(ref);
    if (at >= 0 && ref.length > number.length) {
      const refNode = element('span', 'linked-pr-ref');
      const repoNode = element('span', 'linked-pr-repo', pr.repo);
      repoNode.title = pr.repo;
      refNode.append(repoNode, element('span', 'linked-pr-number', number));
      link.append(text.slice(0, at), refNode);
      appendTail(link, text.slice(at + ref.length), pr);
    } else if (stated(pr) && pr.state === 'merged') {
      appendTail(link, text, pr);
    } else {
      link.textContent = text;
    }
    if (ci) {
      // The badge follows the number, with the space the text reads across.
      link.append(' ', ci.badge);
      link.classList.add('with-ci');
    }
    link.setAttribute(
      'aria-label',
      inDialog
        ? linkedDialogName(pr, issueRepo, ci, relation, side, external)
        : linkedPillName(pr, issueRepo, ci, relation),
    );
    const hover = linkedPillTitle(relation, side, pr.title);
    link.title = hover;
    return relation === 'refs' || hasPillTitle(pr.title)
      ? addPillTip(link, hover)
      : link;
  };
  if (inDialog)
    return foldedPills(
      `${issueKey}:linked:${relation}`,
      list,
      pill,
      side === 'issue-outgoing'
        ? `items ${OUTGOING_WORDING[relation]}`
        : `pull requests that ${MORE_WORDING[relation]} this issue`,
    );
  wrap.append(...shown.map(pill));
  if (rest.length === 0) return wrap;

  const more = element('button', 'linked-pr-more', `${rest.length} more`);
  more.type = 'button';
  more.setAttribute('aria-label', linkedMoreName(rest.length, relation));
  const reveal = () => {
    const extra = rest.map(pill);
    more.replaceWith(...extra);
    expanded.add(`${issueKey}:${relation}`);
    return extra;
  };
  more.addEventListener('click', () => focusPill(reveal()[0]));
  wrap.append(more);
  if (expanded.has(`${issueKey}:${relation}`)) reveal();
  return wrap;
}
