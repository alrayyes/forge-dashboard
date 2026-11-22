// What a pill's hover or focus reads early (see prefetch.ts). Both reads only
// warm what the server keeps, so a first open finds it ready; neither draws
// anything, and a failed one is silent: the open reads again and says so.

import { type AdvisoryRead, readAdvisoryList } from './advisories-dialog';
import type { Subject } from './check-feed';
import type { Advisories } from './main-branches';
import type { Check } from './pipeline-checks';
import {
  type ExcerptReads,
  excerptKey,
  fillExcerpts,
  newExcerptReads,
  pickExcerptJobs,
} from './pipeline-excerpts';
import type { RepoRef } from './run-log';

type Fetcher = (url: string) => Promise<Response>;

const advisoryReads = new Map<string, Promise<AdvisoryRead>>();
const advisoryKey = (r: RepoRef) => `${r.forge}|${r.fullName}`;

// The advisory list the dialog will ask for. A row the server already keeps a
// list for (listReadAt) opens on it, so nothing is read for that one.
export function warmAdvisories(
  row: RepoRef & { advisories?: Advisories },
  fetcher: Fetcher = (url) => fetch(url),
): void {
  const key = advisoryKey(row);
  if (row.advisories?.listReadAt || advisoryReads.has(key)) return;
  const read = readAdvisoryList(row.forge, row.fullName, fetcher).finally(() =>
    advisoryReads.delete(key),
  );
  advisoryReads.set(key, read);
}

// The read warmAdvisories still has out for a repo, so a dialog that opens
// meanwhile waits on it rather than make a second one.
export function advisoriesReadInFlight(
  repo: RepoRef,
): Promise<AdvisoryRead> | undefined {
  return advisoryReads.get(advisoryKey(repo));
}

type Feed = {
  watch(
    subject: Subject,
    follower: (message: { checks: Check[] } | { error: string }) => void,
  ): () => void;
};

// What the pipeline dialog takes over from a warm read: the excerpts it has
// and the one budget of five reads an open may make, as the warm reads left it.
export type WarmedExcerpts = {
  excerpts: Record<string, string>;
  reads: ExcerptReads;
};

export type WarmedChecks = {
  // Lets go of the watch and stops the excerpt reads, retries included.
  release: () => void;
  // The dialog is opening: stops the excerpt reads, keeps the watch for the
  // page to let go of once the dialog watches, and hands over what was read.
  handoff: () => WarmedExcerpts;
};

// The job list the pipeline dialog will watch, held on the page's feed so the
// open is handed it at once, and the log excerpts of the newest failed jobs,
// which the server keeps. A subject the page already watches adds none to the
// stream's cap; any other takes one until released.
export function warmChecks(
  subject: Subject,
  repo: RepoRef,
  feed: Feed,
  fetcher: typeof fetch = fetch,
  wait?: (ms: number) => Promise<void>,
): WarmedChecks {
  const reads = newExcerptReads();
  const filled: Record<string, string> = {};
  let stopped = false;
  const unwatch = feed.watch(subject, (message) => {
    if (stopped || !('checks' in message)) return;
    const picks = pickExcerptJobs(message.checks, reads);
    if (!picks.length) return;
    void fillExcerpts(
      picks,
      repo,
      (check, text) => {
        filled[excerptKey(check)] = text;
      },
      fetcher,
      () => stopped,
      wait,
      reads,
    );
  });
  return {
    release() {
      stopped = true;
      unwatch();
    },
    handoff() {
      stopped = true;
      // The same budget the warm reads drew on: what they spent, retries and
      // reads still out included, is gone from the dialog's five too. A job
      // whose read was still out, or waiting on a retry, gave no excerpt now
      // that the reads have stopped, so it is not marked asked: the dialog may
      // pick it again, from the reads that are left.
      const got = new Set(Object.keys(filled));
      for (const key of [...reads.asked])
        if (!got.has(key)) reads.asked.delete(key);
      return { excerpts: { ...filled }, reads };
    },
  };
}
