import type { Subject } from './check-feed';
import { STREAM_SUBJECT_CAP } from './main-branches';

type Row = { forge: string; repo: string; number: number };

// The key the board gives a pull request row, whether it is read from a row or
// from the subject that row is watched under.
export function pullRequestKey(
  row: Row | Pick<Subject, 'forge' | 'fullName' | 'number'>,
): string {
  const repo = 'repo' in row ? row.repo : row.fullName;

  return `${row.forge}:${repo}#${row.number}`;
}

// The pull requests to watch for live jobs: the first rows the page draws, in
// the order it draws them. One slot of the cap stays free for the pipeline
// dialog, which watches its own subject through the same stream. A row past
// the limit keeps the refresh's pill.
export function pullRequestsToWatch(
  shown: readonly Row[],
  limit: number = STREAM_SUBJECT_CAP - 1,
): Subject[] {
  const seen = new Set<string>();
  const wanted: Subject[] = [];

  for (const row of shown) {
    const key = pullRequestKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({
      kind: 'pull_request',
      forge: row.forge,
      fullName: row.repo,
      number: row.number,
    });
  }

  return wanted.slice(0, Math.min(limit, STREAM_SUBJECT_CAP - 1));
}
