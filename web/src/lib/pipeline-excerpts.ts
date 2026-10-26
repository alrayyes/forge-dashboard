// Reading the log excerpt of Forgejo's failed checks after the list is on
// screen. The list carries no excerpt on Forgejo, since that would read a log
// while it is built; the dialog asks for the newest few as it shows them. No
// DOM here.

import { type Check, checkRunKey } from './pipeline-checks';
import { forgeOf, logUrl } from './run-log';

// How many failed checks of one list are asked for an excerpt, the newest
// first: each is a log read on the forge.
export const MAX_EXCERPT_READS = 5;

// A job that just failed may not have flushed its log yet, so a read that
// comes back with an empty answer is tried again after this pause, at most
// twice more. The server remembers an empty log for less time than this, so
// the retry reads the forge afresh. A read that failed (a non-2xx answer) is
// not retried: the server remembers it for a minute and would answer the retry
// with nothing. A log that is gone is answered like an empty one, so it is
// retried too; the server answers those from its memory without a forge read,
// but each retry still takes one of the five reads.
export const EXCERPT_RETRY_DELAY_MS = 15_000;
const EXCERPT_RETRIES = 2;

// The reads one open of the dialog may still make: each pick and each retry
// takes one from `left`, whichever run of fillExcerpts makes it, so the five
// hold across overlapping runs. `asked` keeps a check from being picked twice.
export type ExcerptReads = { asked: Set<string>; left: number };

export function newExcerptReads(): ExcerptReads {
  return { asked: new Set(), left: MAX_EXCERPT_READS };
}

// The log endpoint's excerpt for one job, or null where the list already
// carries the excerpt (GitHub) or the checks url names no repository.
export function excerptUrl(checksUrl: string, jobId: number): string | null {
  const url =
    forgeOf(checksUrl) === 'forgejo' ? logUrl(checksUrl, jobId) : null;

  return url ? `${url}&excerpt=true` : null;
}

// What names one run of a check's job, so a rerun is asked for afresh.
export function excerptKey(check: Check): string {
  return `${check.jobId}|${checkRunKey(check)}`;
}

// The failed or timed-out checks to ask for an excerpt: the newest ones that
// have a job and no excerpt yet and were not asked for already (by key), as many
// as the reads of one open have left. Each pick spends a read at once, so a
// second call before the first has fetched cannot overspend, and a newer
// failure that appears later cannot push the open past five. A rerun is a new
// key, so it spends a read of its own; a job that left the list gives none back.
export function pickExcerptJobs(checks: Check[], reads: ExcerptReads): Check[] {
  const picks = checks
    .filter(
      (c) =>
        (c.state === 'failure' || c.state === 'timed_out') &&
        !!c.jobId &&
        !c.excerpt &&
        !reads.asked.has(excerptKey(c)),
    )
    .sort((a, b) => (b.jobId ?? 0) - (a.jobId ?? 0))
    .slice(0, Math.max(0, reads.left));
  for (const c of picks) reads.asked.add(excerptKey(c));
  reads.left -= picks.length;

  return picks;
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Asks for the excerpt of each pick (from pickExcerptJobs) in turn and hands every one that has text
// to `fill` as it lands. A job whose read came back empty is asked for again
// after `wait` (EXCERPT_RETRY_DELAY_MS), at most twice, since its log may not
// have been flushed yet; the others are not held up. A failed read is not
// asked for again. Each retry spends a read from `reads`, and a retry that finds
// none left is not made. A signed-out session, a refused token or a rate limit stops everything,
// retries included, since they would be refused the same way. `stopped` says
// the dialog moved on.
export async function fillExcerpts(
  picks: Check[],
  checksUrl: string,
  fill: (check: Check, text: string) => void,
  fetchImpl: typeof fetch = fetch,
  stopped: () => boolean = () => false,
  wait: (ms: number) => Promise<void> = pause,
  reads: ExcerptReads = newExcerptReads(),
): Promise<void> {
  let pending = picks;
  for (let round = 0; round <= EXCERPT_RETRIES && pending.length; round++) {
    if (round > 0) {
      await wait(EXCERPT_RETRY_DELAY_MS);
      if (stopped()) return;
    }
    const empty: Check[] = [];
    for (const check of pending) {
      // A job with no log address shows without an excerpt and costs no read;
      // the others are still asked for theirs.
      const url = check.jobId ? excerptUrl(checksUrl, check.jobId) : null;
      if (!url) continue;
      if (round > 0) {
        if (reads.left <= 0) return;
        reads.left--;
      }
      if (stopped()) return;
      try {
        const res = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
        });
        if (res.status === 401 || res.status === 403 || res.status === 429)
          return;
        if (!res.ok) continue;
        const body = await res.json().catch(() => null);
        if (stopped()) return;
        if (typeof body?.text !== 'string') continue;
        if (body.text) fill(check, body.text);
        else empty.push(check);
      } catch {
        // This one shows without an excerpt; the next may still land.
      }
    }
    pending = empty;
  }
}
