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
    const res = await fetcher(`/api/main-branches/advisories?${query}`);
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
