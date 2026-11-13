// The words of the one banner that says a forge is unreachable (#3719). Each
// fact appears once: which forge, how old the rows on screen are, and that the
// page retries on its own. Both forges down share one sentence.

export type DownForge = {
  forge: string;
  label: string;
  errorKind?: string;
  staleSince?: string;
  // Right after a restart the first refresh is still running (#3554).
  startupGap?: boolean;
  // What the forge answered, for a 5xx that is not an outage (#3527).
  upstreamError?: string;
  // What the forge's own status page reports (#3633), GitHub only.
  providerStatus?: ProviderStatus;
};

export type ProviderStatus = {
  indicator: string;
  components?: string[];
  incidents?: string[];
};

export type BannerCopy = {
  headline: string;
  detail: string;
  // GitHub has a status page to link; a self-hosted Forgejo has none (#1301).
  statusLink: boolean;
  // A second sentence when GitHub itself reports an incident (#3633).
  incident?: string;
};

type Format = {
  time: (iso: string) => string;
  ago: (iso: string) => string;
};

function headlineOf(f: DownForge): string {
  if (f.startupGap) return `${f.label} is starting up.`;
  if (f.errorKind === 'upstream_error' && f.upstreamError)
    return `${f.upstreamError}.`;
  return `${f.label} is unreachable.`;
}

// What the page does about it, or what the reader has to fix.
function causeOf(f: DownForge): string {
  if (f.startupGap) return 'Retrying automatically.';
  switch (f.errorKind) {
    case 'unauthorized':
      return 'Check the token in Settings.';
    case 'not_found':
      return 'Check the instance URL in Settings.';
    case 'unreachable':
    case 'upstream_error':
      return 'Retrying automatically.';
    default:
      return 'Something went wrong talking to it.';
  }
}

function joinLabels(labels: string[]): string {
  return labels.length <= 2
    ? labels.join(' and ')
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// GitHub's own report, said when it names something this page uses. A restart
// still waiting for its first answer is not an outage to blame on GitHub.
function incidentOf(down: DownForge[]): string | undefined {
  const gh = down.find((f) => f.forge === 'github' && !f.startupGap);
  const incidents = gh?.providerStatus?.incidents ?? [];
  const components = gh?.providerStatus?.components ?? [];
  if (incidents.length > 0) {
    const affects =
      components.length > 0 ? ` Affects: ${components.join(', ')}.` : '';
    return `GitHub reports an incident: ${incidents.join('; ')}.${affects}`;
  }
  if (components.length > 0)
    return `GitHub reports trouble with: ${components.join(', ')}.`;
  return undefined;
}

export function bannerCopy(down: DownForge[], fmt: Format): BannerCopy {
  // GitHub first, as the toolbar orders the forges.
  const ordered = [...down].sort(
    (a, b) => Number(b.forge === 'github') - Number(a.forge === 'github'),
  );
  const headline =
    ordered.length === 1
      ? headlineOf(ordered[0])
      : `${joinLabels(ordered.map((f) => f.label))} are ${
          ordered.every((f) => f.startupGap) ? 'starting up' : 'unreachable'
        }.`;
  // The oldest rows on screen are the ones to be careful with.
  const oldest = ordered
    .map((f) => f.staleSince)
    .filter((s): s is string => !!s)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
  const parts: string[] = [];
  if (oldest)
    parts.push(`Showing data from ${fmt.time(oldest)}, ${fmt.ago(oldest)}.`);
  for (const c of new Set(ordered.map(causeOf))) parts.push(c);
  return {
    headline,
    detail: parts.join(' '),
    statusLink: ordered.some((f) => f.forge === 'github'),
    incident: incidentOf(ordered),
  };
}
