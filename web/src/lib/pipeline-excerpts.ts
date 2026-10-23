// Reading the log excerpt of Forgejo's failed checks after the list is on
// screen. The list carries no excerpt on Forgejo, since that would read a log
// while it is built; the dialog asks for the newest few as it shows them. No
// DOM here.

import { type Check, checkRunKey } from './pipeline-checks';
import { logUrl } from './run-log';

// How many failed checks of one list are asked for an excerpt, the newest
// first: each is a log read on the forge.
export const MAX_EXCERPT_READS = 5;

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

// The failed or timed-out checks to ask for an excerpt: of the newest five that
// have a job and no excerpt yet, the ones not asked for already (by key).
export function pickExcerptJobs(checks: Check[], asked: Set<string>): Check[] {
  return checks
    .filter(
      (c) =>
        (c.state === 'failure' || c.state === 'timed_out') &&
        !!c.jobId &&
        !c.excerpt,
    )
    .sort((a, b) => (b.jobId ?? 0) - (a.jobId ?? 0))
    .slice(0, MAX_EXCERPT_READS)
    .filter((c) => !asked.has(excerptKey(c)));
}

// Asks for the excerpt of each pick (from pickExcerptJobs) in turn and hands every one that has text
// to `fill` as it lands. A job with no log, an empty one or a failed read shows
// without an excerpt. A signed-out session, a refused token or a rate limit
// stops the rest, since they would be refused the same way. `stopped` says the
// dialog moved on.
export async function fillExcerpts(
  picks: Check[],
  checksUrl: string,
  fill: (check: Check, text: string) => void,
  fetchImpl: typeof fetch = fetch,
  stopped: () => boolean = () => false,
): Promise<void> {
  for (const check of picks) {
    const url = excerptUrl(checksUrl, check.jobId as number);
    if (!url || stopped()) return;
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403 || res.status === 429)
        return;
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      if (stopped()) return;
      if (typeof body?.text === 'string' && body.text) fill(check, body.text);
    } catch {
      // This one shows without an excerpt; the next may still land.
    }
  }
}
