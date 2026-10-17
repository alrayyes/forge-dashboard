// The two issue settings the server keeps per user and applies itself (#1630):
// hideDependencyDashboard and ignoredTitles. The server leaves matching
// issues out of the snapshot and the counts, so nothing here filters. This
// only shapes what Settings sends and what the Issues and Insights pages read.

export const MAX_IGNORED_TITLES = 20;
export const MAX_PATTERN_LENGTH = 200;

// The server counts characters (runes), not UTF-16 units, so an emoji is one.
const length = (text: string) => Array.from(text).length;

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
    if (!pattern || length(pattern) > MAX_PATTERN_LENGTH) continue;
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
  if (length(pattern) > MAX_PATTERN_LENGTH)
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

// How many open issues each saved pattern hides, keyed by pattern. The server
// sends ignoredTitleCounts in the order of ignoredTitles; null means it does
// not know yet. A missing or mismatched field returns null: no counts at all,
// so the page shows nothing rather than guess. The page never matches titles
// itself, because its regular expression engine differs from the server's.
export function ignoredCountsFrom(
  raw: unknown,
): Map<string, number | null> | null {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const titles = data.ignoredTitles;
  const counts = data.ignoredTitleCounts;
  if (!Array.isArray(titles) || !Array.isArray(counts)) return null;
  if (titles.length !== counts.length) return null;
  const out = new Map<string, number | null>();
  titles.forEach((title, i) => {
    if (typeof title !== 'string') return;
    const key = title.trim();
    if (!key || out.has(key)) return;
    const count = counts[i];
    out.set(
      key,
      typeof count === 'number' && Number.isInteger(count) && count >= 0
        ? count
        : null,
    );
  });
  return out;
}

// The words beside a pattern. Zero is said, not hidden: "matches nothing" is
// the point. Unknown says nothing. A pattern not saved yet has no count.
export function ignoredCountLabel(
  count: number | null | undefined,
  saved: boolean,
): string {
  if (!saved) return 'Counted after you save';
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
    return '';
  if (count === 0) return 'hides no issues';
  return count === 1 ? 'hides 1 issue' : `hides ${count} issues`;
}
