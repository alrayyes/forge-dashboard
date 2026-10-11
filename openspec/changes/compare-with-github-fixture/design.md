# Design

## Two sources, no shared code

GitHub's side is asked with `gh api graphql` and the REST API through `gh`. The
dashboard's side is `github.Client.FetchRepo` plus `dashboard.AllowedActions`.
The test never reuses the client's query or mapping for GitHub's answer, or it
would repeat the client's mistakes.

## What counts as GitHub's answer

- Merge: `mergeStateStatus` of CLEAN, UNSTABLE or HAS_HOOKS, and not a draft.
  The REST merge endpoint refuses a draft even when the state says CLEAN.
- Owner bypass: `viewerCanMergeAsAdmin` on a BLOCKED pull request. The dashboard
  never offers it, on purpose, so this is its own verdict, "expected", with the
  declined ticket.
- Behind: the compare endpoint's `behind_by`. `mergeStateStatus` can't say,
  since DIRTY or BLOCKED outrank BEHIND, and a non-strict repo reports CLEAN for
  a branch that is behind.
- Auto-merge: `autoMergeRequest` for armed, `viewerCanEnableAutoMerge` for
  allowed.

## Fixture hazards found on the way

- **Auto-merge on a pull request waiting for a check merges it** once the check
  passes, into a base other pull requests share. The armed pull request waits
  for a review nobody gives instead.
- **A slow check that ends after ten minutes** flips pending scenarios to
  passing. The bases carry a copy of the workflow that sleeps 55 minutes; `main`
  is protected, so the change sits on the bases and not on `main`.
- **The dashboard's own auto-update bot updates behind branches** in any repo it
  watches, whatever the UI hides. Touching a workflow file doesn't stop it. The
  two behind pull requests carry the `autorelease: pending` label instead, which
  makes the pass treat them as release-please's and leave them alone.
- **Merging in the method tests moves their base**, which makes every pull
  request on it behind. They merge into two bases of their own.
- **Merge-commit-only is impossible** while any branch requires linear history,
  so the test turns that rule off for its merge-commit-only case and puts it
  back.

## Not in CI

The repository's `GITHUB_TOKEN` can only reach this repository. Reaching the
fixture repo, changing its settings and merging in it would need a personal
access token with admin rights, stored as a secret and used on a schedule.
That is more exposure than the check is worth, so the run is manual
(CONTRIBUTING.md, "Comparing with real GitHub").
