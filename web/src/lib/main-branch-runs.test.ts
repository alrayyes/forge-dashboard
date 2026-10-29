import { describe, expect, test } from 'bun:test';
import { foldBranch } from './check-fold';
import { type MainBranch, withSnapshotRuns } from './main-branches';
import fixture from './testdata/main-branch-runs.json';
import cutShort from './testdata/main-branch-runs-cut-short.json';
import githubFixture from './testdata/main-branch-runs-github.json';

// The fixture is the row the server sends for a default branch with two runs
// (internal/forgejo/main_branch_runs_test.go asserts the server produces it), so
// folding its runs here is checked against the status and counts the server
// worked out from the same jobs, not against a copy of the rule.
const row = fixture as Pick<MainBranch, 'status' | 'checks' | 'runs'>;

describe('a default branch row with run facts', () => {
  const folded = foldBranch((row.runs ?? []).flatMap((run) => run.checks));

  test('folds to the status the server sent', () => {
    expect(folded.status).toBe(row.status);
  });

  test('folds to the counts the server sent', () => {
    expect(folded.counts).toEqual(row.checks as typeof folded.counts);
  });
});

// The fixture is the row the server sends for a GitHub default branch, whose
// checks are grouped by workflow run (internal/github/main_branch_runs_test.go
// asserts the server produces it): a failed run, a run going, and a check of
// another app that belongs to no run.
describe('a GitHub default branch row with run facts', () => {
  const github = githubFixture as MainBranch;
  const folded = foldBranch((github.runs ?? []).flatMap((run) => run.checks));

  test('folds to the status the server sent', () => {
    expect(folded.status).toBe(github.status);
  });

  test('folds to the counts the server sent', () => {
    expect(folded.counts).toEqual(github.checks as typeof folded.counts);
  });

  test('names the failed job the server would', () => {
    expect(folded.failing).toEqual(['unit']);
  });
});

// The fixture is the row for a run the forge cut the job list of short
// (internal/forgejo/main_branch_runs_test.go asserts the server produces it):
// every listed job is green, yet the server calls the row failed.
describe('a default branch row whose run has a cut-short job list', () => {
  const cut = cutShort as MainBranch;
  const folded = foldBranch((cut.runs ?? []).flatMap((run) => run.checks));

  test('would fold to a pill the server did not send', () => {
    expect(folded.status).not.toBe(cut.status);
  });

  test('keeps the status and counts the server sent', () => {
    const [out] = withSnapshotRuns([cut]);

    expect(out.status).toBe(cut.status);
    expect(out.checks).toEqual(cut.checks);
  });
});
