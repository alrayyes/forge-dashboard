// The two issue settings the server keeps per user and applies itself (#1630):
// hideDependencyDashboard and ignoredTitles. The server leaves matching
// issues out of the snapshot and the counts, so nothing here filters. This
// only shapes what Settings sends and what the Issues and Insights pages read.

export const MAX_IGNORED_TITLES = 20;
export const MAX_PATTERN_LENGTH = 200;

export interface IssueSettings {
  hideDependencyDashboard: boolean;
  ignoredTitles: string[];
}

// A saved or sent list as the server would keep it: strings only, trimmed,
// no blanks, no repeats (ignoring case), nothing over-long, at most the cap.
// Anything else is dropped rather than thrown on.
export function normaliseIgnoredTitles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const pattern = entry.trim();
    if (!pattern || pattern.length > MAX_PATTERN_LENGTH) continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pattern);
    if (out.length === MAX_IGNORED_TITLES) break;
  }
  return out;
}

// Missing fields (a server that does not send them yet) mean off and empty.
export function issueSettingsFrom(raw: unknown): IssueSettings {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    hideDependencyDashboard: data.hideDependencyDashboard === true,
    ignoredTitles: normaliseIgnoredTitles(data.ignoredTitles),
  };
}

// Adds one typed pattern. Blanks and repeats change nothing and are not an
// error; a pattern that cannot be kept says why in plain words. Whether the
// pattern is a valid expression is the server's call, on save.
export function addIgnoredTitle(
  list: string[],
  typed: string,
): { list: string[]; error?: string } {
  const pattern = typed.trim();
  if (!pattern) return { list };
  if (pattern.length > MAX_PATTERN_LENGTH)
    return {
      list,
      error: `A pattern can be at most ${MAX_PATTERN_LENGTH} characters.`,
    };
  if (list.some((p) => p.toLowerCase() === pattern.toLowerCase()))
    return { list };
  if (list.length >= MAX_IGNORED_TITLES)
    return {
      list,
      error: `You can ignore at most ${MAX_IGNORED_TITLES} titles. Remove one first.`,
    };
  return { list: [...list, pattern] };
}

// What the Issues and Insights pages need to know. A failed load is null:
// the page keeps its own fields and says nothing about what the settings hid,
// since it can't tell whether they apply.
export function loadIssueSettings(): Promise<IssueSettings | null> {
  return fetch('/api/settings', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (data ? issueSettingsFrom(data) : null))
    .catch(() => null);
}
