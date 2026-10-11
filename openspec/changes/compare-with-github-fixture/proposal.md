# Proposal

## Why

The unit tests for merge status and allowed actions feed hand-written GitHub
payloads to the code, so they prove the code matches what we assumed GitHub
says. They can't find the case Ryan reported in
https://github.com/alrayyes/forge-dashboard/issues/950: a pull request that is
mergeable on GitHub with Merge disabled in the dashboard.

The first fixture run found three such gaps (optional checks, drafts, owner
bypass). Those are fixed or decided. The harness still covers only part of the
state list in the ticket, and the fixture drifted: a pull request waiting on a
slow check merged itself into its base after ten minutes, and the dashboard's
own auto-update bot brought the "behind" pull requests up to date before the
test looked.

## What Changes

- The fixture repo gets one pull request for every state in the ticket that can
  be built and left open: also stacked, auto-merge armed, closed and merged.
  Merge-method and auto-merge-setting scenarios are opened and cleaned up by
  the test itself, because they flip repo settings.
- The test prints one row per pull request: what GitHub says, what the
  dashboard says, and the verdict. It compares Merge, draft, behind, auto-merge
  armed and allowed, and whether Enable auto-merge is offered.
- Every difference is either listed by reason (deliberate), listed by ticket
  (a bug, until fixed), or fails the run. A listed difference that now agrees
  fails the run too, so the list can't rot.
- The repo-level tests check that Merge picks a method the repo accepts when
  merge, squash or rebase is the only one allowed, and when the base branch
  requires linear history; and that Enable auto-merge follows the repo setting.

Out of scope, as in the ticket: merge queues, CODEOWNERS, signed-commit rules
and bot pull requests.

## Findings

- The owner's merge of a BLOCKED pull request (GitHub's "merge without waiting
  for requirements") stays a documented difference, not a bug:
  https://github.com/alrayyes/forge-dashboard/issues/958 was declined.
- A pull request whose base branch (not the default branch) requires linear
  history is merged with a merge commit and refused:
  https://github.com/alrayyes/forge-dashboard/issues/1173.
- A pull request that is behind its base in a repo that doesn't require
  up-to-date branches shows as not behind, because GitHub reports CLEAN:
  https://github.com/alrayyes/forge-dashboard/issues/1183. Merge agrees; only
  Update branch and the auto-update pass are affected. It needs a decision on
  cost, so it stays a listed difference.
