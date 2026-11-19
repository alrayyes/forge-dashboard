// The items that refer to an issue, as its details list them (#4271), put in
// the shape the issue dialog's Related band already draws. The board's own
// pills know only open pull requests; this is what a closed issue has, since
// no snapshot row carries it.

import type { LinkedPullRequest } from './linked-pull-requests.js';

/** Matches components.schemas.ItemReference in api/openapi.yaml. */
export type ItemReference = {
  forge: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  pageUrl: string;
  kind: 'issue' | 'pullRequest';
  state: 'open' | 'closed' | 'merged';
  direction: 'incoming' | 'outgoing';
  relation: 'closes' | 'refs' | 'mentions';
};

export type IncomingRows = {
  linkedPullRequests: LinkedPullRequest[];
  referencedByPullRequests: LinkedPullRequest[];
  mentionedByPullRequests: LinkedPullRequest[];
};

/** What the issue itself refers to, by what it does. */
export type OutgoingRows = {
  closes: LinkedPullRequest[];
  refs: LinkedPullRequest[];
  mentions: LinkedPullRequest[];
};

const none = { passed: 0, running: 0, waiting: 0, failed: 0 };

/**
 * The incoming references as the three rows of the issue's band. An outgoing
 * one is what the issue itself refers to, which the band does not draw yet.
 */
export function incomingRows(
  references: readonly ItemReference[],
): IncomingRows {
  const rows: IncomingRows = {
    linkedPullRequests: [],
    referencedByPullRequests: [],
    mentionedByPullRequests: [],
  };
  const rowOf = {
    closes: rows.linkedPullRequests,
    refs: rows.referencedByPullRequests,
    mentions: rows.mentionedByPullRequests,
  };
  for (const ref of references) {
    if (ref.direction !== 'incoming') continue;

    rowOf[ref.relation].push(pill(ref));
  }
  return rows;
}

/** The outgoing references: what the issue closes, references and mentions. */
export function outgoingRows(
  references: readonly ItemReference[],
): OutgoingRows {
  const rows: OutgoingRows = { closes: [], refs: [], mentions: [] };
  for (const ref of references)
    if (ref.direction === 'outgoing') rows[ref.relation].push(pill(ref));
  return rows;
}

function pill(ref: ItemReference): LinkedPullRequest {
  return {
    forge: ref.forge,
    repo: ref.repo,
    number: ref.number,
    draft: false,
    pageUrl: ref.pageUrl,
    ci: 'none',
    checks: none,
    awaitingWorkflowApproval: false,
    kind: ref.kind,
    state: ref.state,
    url: ref.url,
  };
}

/**
 * What the board already drew for the issue plus what its details found. A
 * pill the board drew stays as it is, since it carries the checks the details
 * do not know; an item only the details list is added after it.
 */
export function mergeRows(
  board: IncomingRows,
  found: IncomingRows,
): IncomingRows {
  const all = [
    ...board.linkedPullRequests,
    ...board.referencedByPullRequests,
    ...board.mentionedByPullRequests,
  ];
  const drawn = new Set(all.map((p) => `${p.forge}/${p.repo}#${p.number}`));
  const added = (rows: LinkedPullRequest[]) =>
    rows.filter((p) => !drawn.has(`${p.forge}/${p.repo}#${p.number}`));

  return {
    linkedPullRequests: [
      ...board.linkedPullRequests,
      ...added(found.linkedPullRequests),
    ],
    referencedByPullRequests: [
      ...board.referencedByPullRequests,
      ...added(found.referencedByPullRequests),
    ],
    mentionedByPullRequests: [
      ...board.mentionedByPullRequests,
      ...added(found.mentionedByPullRequests),
    ],
  };
}
