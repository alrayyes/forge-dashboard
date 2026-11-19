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

    rowOf[ref.relation].push({
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
    });
  }
  return rows;
}
