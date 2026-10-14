// What the Insights page works out from the items it is given: which age
// bucket each falls in, and how repos rank. Pure, so it is tested without a
// browser (insights.test.ts); the page only draws the answers.
// https://github.com/alrayyes/forge-dashboard/issues/1383
import type { FilterableItem } from './filters';

export const REPO_RANK_CAP = 10;

// Fixed age buckets, oldest-catch-all last so nothing older ever gets
// dropped instead of counted.
export const AGE_BUCKETS = [
  { key: 'lt1', label: '<1 day', maxHours: 24 },
  { key: '1to3', label: '1-3 days', maxHours: 24 * 3 },
  { key: '3to7', label: '3-7 days', maxHours: 24 * 7 },
  { key: '7to30', label: '7-30 days', maxHours: 24 * 30 },
  { key: '30plus', label: '30+ days', maxHours: Number.POSITIVE_INFINITY },
] as const;

export function bucketForAge(hoursOld: number): string {
  const bucket = AGE_BUCKETS.find((b) => hoursOld < b.maxHours);
  return bucket ? bucket.key : AGE_BUCKETS[AGE_BUCKETS.length - 1].key;
}

export function bucketAges(items: FilterableItem[], now = Date.now()) {
  const counts: Record<string, number> = {};
  for (const b of AGE_BUCKETS) counts[b.key] = 0;
  for (const item of items) {
    const hoursOld =
      (now - new Date(item.createdAt).getTime()) / (60 * 60 * 1000);
    counts[bucketForAge(hoursOld)]++;
  }
  const maxCount = Math.max(...AGE_BUCKETS.map((b) => counts[b.key]));
  return { counts, maxCount };
}

// Ranked by count, single neutral hue — repo identity rides the label,
// not a color, since a fixed categorical hue order doesn't scale past
// a handful of repos.
export function rankByRepo(items: FilterableItem[]) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.repo] = (counts[item.repo] || 0) + 1;
  const ranked = Object.keys(counts)
    .map((repo) => ({ repo, count: counts[repo] }))
    .sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, REPO_RANK_CAP);
  const maxCount = top.length > 0 ? top[0].count : 0;
  const remaining = ranked.length - top.length;
  return { top, maxCount, remaining };
}
