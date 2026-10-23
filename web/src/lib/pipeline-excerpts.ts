// Reading the log excerpt of Forgejo's failed checks after the list is on
// screen. The list carries no excerpt on Forgejo, since that would read a log
// while it is built; the dialog asks for the newest few as it shows them. No
// DOM here.

import { type Check, checkRunKey } from './pipeline-checks';
import { logUrl } from './run-log';

// How many failed checks of one list are asked for an excerpt, the newest
// first: each is a log read on the forge.
export const MAX_EXCERPT_READS = 5;

// A job that just failed may not have flushed its log yet, so a read that
// brings no text is tried again after this pause, at most twice more. The
// server remembers an empty log for less time than this, so the retry reads
// the forge afresh.
export const EXCERPT_RETRY_DELAY_MS = 15_000;
const EXCERPT_RETRIES = 2;

// The log endpoint's excerpt for one job, or null where the list already
// carries the excerpt (GitHub) or the checks url names no repository.
export function excerptUrl(checksUrl: string, jobId: number): string | null {
  const forge = new URLSearchParams(checksUrl.split('?')[1] ?? '').get('forge');
  const url = forge === 'forgejo' ? logUrl(checksUrl, jobId) : null;

  return url ? `${url}&excerpt=true` : null;
}

// What names one run of a check's job, so a rerun is asked for afresh.
export function excerptKey(check: Check): string {
  return `${check.jobId}|${checkRunKey(check)}`;
}

// The failed or timed-out checks to ask for an excerpt: the newest ones that
// have a job and no excerpt yet and were not asked for already (by key), as many
// as the five reads of one open leave. A job asked for earlier keeps its place,
// so a newer failure that appears later cannot push the open past five.
export function pickExcerptJobs(checks: Check[], asked: Set<string>): Check[] {
  return checks
    .filter(
      (c) =>
        (c.state === 'failure' || c.state === 'timed_out') &&
        !!c.jobId &&
        !c.excerpt &&
        !asked.has(excerptKey(c)),
    )
    .sort((a, b) => (b.jobId ?? 0) - (a.jobId ?? 0))
    .slice(0, Math.max(0, MAX_EXCERPT_READS - asked.size));
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Asks for the excerpt of each pick (from pickExcerptJobs) in turn and hands every one that has text
// to `fill` as it lands. A job whose read brought no text, whether empty, failed
// or missing, is asked for again after `wait` (EXCERPT_RETRY_DELAY_MS), at most
// twice, since its log may not have been flushed yet; the others are not held
// up. A signed-out session, a refused token or a rate limit stops everything,
// retries included, since they would be refused the same way. `stopped` says
// the dialog moved on.
export async function fillExcerpts(
  picks: Check[],
  checksUrl: string,
  fill: (check: Check, text: string) => void,
  fetchImpl: typeof fetch = fetch,
  stopped: () => boolean = () => false,
  wait: (ms: number) => Promise<void> = pause,
): Promise<void> {
  let pending = picks;
  for (let round = 0; round <= EXCERPT_RETRIES && pending.length; round++) {
    if (round > 0) {
      await wait(EXCERPT_RETRY_DELAY_MS);
      if (stopped()) return;
    }
    const empty: Check[] = [];
    for (const check of pending) {
      const url = excerptUrl(checksUrl, check.jobId as number);
      if (!url || stopped()) return;
      try {
        const res = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
        });
        if (res.status === 401 || res.status === 403 || res.status === 429)
          return;
        if (!res.ok) {
          empty.push(check);
          continue;
        }
        const body = await res.json().catch(() => null);
        if (stopped()) return;
        if (typeof body?.text === 'string' && body.text) fill(check, body.text);
        else empty.push(check);
      } catch {
        // This one shows without an excerpt for now; the next may still land.
        empty.push(check);
      }
    }
    pending = empty;
  }
}
