import { describe, expect, test } from 'bun:test';
import { foldBranch } from './check-fold';
import type { MainBranch } from './main-branches';
import fixture from './testdata/main-branch-runs.json';

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
