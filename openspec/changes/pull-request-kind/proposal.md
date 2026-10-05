# Proposal

## Why

The page kept its own copy of who counts as a bot pull request (`isReleasePleasePr`, `isDependabotPr`, `isRenovatePr`) beside the Go rules, so a second client would have to copy it too. Found by the audit against `rules/frontend.md` (alrayyes/dotfiles#705), part of [alrayyes/forge-dashboard#716](https://github.com/alrayyes/forge-dashboard/issues/716).

## What Changes

- Each pull request in the API carries `kind`: `release`, `dependency` or `regular`, decided in `internal/dashboard` in one place.
- The page's "Bot PRs" quick filter reads it, and the page's own copy of the rule is deleted.
- Not in this change: the row chip, the Release and Dependencies pills and Group by kind, which wait on the ticket's open decision between chips and tabs.

## Capabilities

### Modified Capabilities

- `pr-merge-status`: a pull request's kind comes from the server.
