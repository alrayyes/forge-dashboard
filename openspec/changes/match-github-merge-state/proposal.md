# Proposal

## Why

The fixture test from #950 compared the dashboard's Merge button with what
GitHub itself reports for 17 pull request states in
`alrayyes/forge-dashboard-e2e-fixture`. Two groups differ:

- A PR whose only failing or pending check isn't required. GitHub reports
  `mergeStateStatus: UNSTABLE` with `mergeable: MERGEABLE`, and the merge
  goes through. The dashboard blocks it (#952). This is the case where Merge
  was disabled in the UI while GitHub allowed it.
- A clean draft PR. The dashboard offers Merge, and GitHub's merge API
  answers 405 "Pull Request is still a draft" (#954).

GitHub's docs describe the states:
[MergeStateStatus](https://docs.github.com/en/graphql/reference/enums#mergestatestatus).

## What Changes

- Merge stays enabled when GitHub says UNSTABLE, so long as no _required_
  check is failing or pending. The optional failure stays visible.
- Merge is blocked with the reason "Draft" while a PR is a draft.

Out of scope: the owner's admin bypass (#953), which needs a decision first.
