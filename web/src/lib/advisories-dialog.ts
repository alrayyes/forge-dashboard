import { ADVISORY_REASON_TEXT } from './main-branches';

// Pure helpers for the advisories dialog: the shapes the endpoint returns,
// the severity filter, and the text the list and detail views print.

export type AdvisorySeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AdvisoryCVSS {
  score?: number;
  vector?: string;
}

export interface AdvisoryEPSS {
  percentage: number;
  percentile: number;
}

export interface AdvisoryItem {
  number: number;
  state: string;
  severity?: AdvisorySeverity | string;
  summary: string;
  // The advisory's own id, for a source with no GHSA or CVE id to show.
  id?: string;
  ghsaId?: string;
  cveId?: string;
  package?: string;
  ecosystem?: string;
  scope?: string;
  relationship?: string;
  manifestPath?: string;
  openedAt?: string;
  vulnerableVersions?: string;
  patchedVersion?: string;
  cvss?: AdvisoryCVSS;
  weaknesses?: { id: string; name?: string }[];
  description?: string;
  references?: string[];
  epss?: AdvisoryEPSS;
  url?: string;
}

export interface AdvisoryList {
  state: 'known' | 'unknown';
  reason?: string;
  // A Forgejo list that leaves out packages it may not send to OSV.
  partial?: boolean;
  url?: string;
  advisories: AdvisoryItem[];
}

export type SeverityFilter = 'all' | AdvisorySeverity;

export type AdvisoryRead =
  | { kind: 'ready'; list: AdvisoryList }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string };

const LEVELS: AdvisorySeverity[] = ['critical', 'high', 'medium', 'low'];

export function severityCounts(
  items: AdvisoryItem[],
): Record<AdvisorySeverity, number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const item of items) {
    if ((LEVELS as string[]).includes(item.severity ?? '')) {
      counts[item.severity as AdvisorySeverity] += 1;
    }
  }
  return counts;
}

export function filterBySeverity(
  items: AdvisoryItem[],
  filter: SeverityFilter,
): AdvisoryItem[] {
  return filter === 'all' ? items : items.filter((i) => i.severity === filter);
}

export interface Chip {
  kind: 'package' | 'scope' | 'relationship';
  text: string;
  detail?: string;
}

export function chipsOf(item: AdvisoryItem): Chip[] {
  const chips: Chip[] = [];
  if (item.package) {
    chips.push({
      kind: 'package',
      text: item.package,
      detail: item.ecosystem ?? '',
    });
  }
  if (item.scope) chips.push({ kind: 'scope', text: item.scope });
  if (item.relationship) {
    chips.push({ kind: 'relationship', text: item.relationship });
  }
  return chips;
}

export function referenceLinks(
  refs: string[] | undefined,
): { url: string; host: string }[] {
  const links: { url: string; host: string }[] = [];
  for (const url of refs ?? []) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        links.push({ url, host: parsed.host });
      }
    } catch {
      // Not a URL: leave it out.
    }
  }
  return links;
}

export function cvssBand(score: number): string {
  if (score >= 9) return 'Critical';
  if (score >= 7) return 'High';
  if (score >= 4) return 'Medium';
  if (score > 0) return 'Low';
  return 'None';
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function epssText(epss: AdvisoryEPSS): string {
  const pct = epss.percentage * 100;
  const shown = pct < 0.01 ? 'under 0.01%' : `${pct.toFixed(2)}%`;
  return `${shown} (${ordinal(Math.round(epss.percentile * 100))} percentile)`;
}

type Fetcher = (url: string) => Promise<Response>;

export async function readAdvisoryList(
  forge: string,
  fullName: string,
  fetcher: Fetcher = (url) => fetch(url),
): Promise<AdvisoryRead> {
  const query = new URLSearchParams({ forge, fullName });
  try {
    const res = await fetcher(`/api/v1/main-branches/advisories?${query}`);
    if (res.status === 401) return { kind: 'signed-out' };
    if (!res.ok) {
      let message = `The advisories could not be read (${res.status}).`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Keep the status text.
      }
      return { kind: 'error', message };
    }
    return { kind: 'ready', list: (await res.json()) as AdvisoryList };
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// The words that differ between a GitHub list (Dependabot alerts) and a
// Forgejo one (OSV matches against lock files).
export function forgeWords(forge: string) {
  if (forge === 'forgejo') {
    return {
      linkName: 'OSV',
      foundIn: 'Found in',
      fileLabel: 'Lock file',
      dateWord: 'Published',
      // OSV lists a fix per branch, so these are the versions that fix it
      // somewhere, not only on the installed version's branch.
      patchedLabel: 'Fixed in',
      empty:
        'No known advisories. OSV lists none for the packages in this repository’s lock files.',
    };
  }
  return {
    linkName: 'GitHub',
    foundIn: 'Detected in',
    fileLabel: 'Detected in',
    dateWord: 'Opened',
    patchedLabel: 'Patched in',
    empty: 'No open advisories. Dependabot reports none for this repository.',
  };
}

const FORGEJO_UNREADABLE: Record<string, string> = {
  not_enabled:
    'Advisories are switched off for Forgejo repositories. Set OSV_ADVISORIES=on to check lock files against OSV; the package names and versions in them are sent to api.osv.dev.',
  failed:
    'OSV could not be reached, the forge did not answer, or a lock file could not be read or is over 8 megabytes. Try again in a moment.',
  too_many:
    'A lock file lists more packages, or the repository matches more advisories, than the dashboard reads in one go.',
};

// Why a list could not be read, in the words of the forge it came from.
export function unreadableText(
  forge: string,
  reason: string | undefined,
): string {
  if (forge === 'forgejo') {
    return (
      (reason && FORGEJO_UNREADABLE[reason]) ||
      'The dashboard found no lock file it reads on the default branch, so nothing was checked.'
    );
  }
  const known = ADVISORY_REASON_TEXT as Record<string, string>;
  return (reason && known[reason]) || 'GitHub did not answer the read.';
}
