import { STREAM_SUBJECT_CAP, type Subject } from './check-feed';
import { SHOWN_PILLS } from './linked-pull-requests';

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

// The pull requests to watch for an issue page: the ones its rows draw a pill
// for, in the order drawn. The pills a row keeps behind its count are not
// drawn, so they are not watched. The same cap applies as for the pull request
// page.
export function linkedPullRequestsToWatch(
  shown: readonly { linkedPullRequests?: readonly Row[] }[],
): Subject[] {
  return pullRequestsToWatch(
    shown.flatMap(
      (issue) => issue.linkedPullRequests?.slice(0, SHOWN_PILLS) ?? [],
    ),
  );
}
