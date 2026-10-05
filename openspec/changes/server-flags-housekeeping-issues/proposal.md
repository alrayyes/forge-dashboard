# Proposal

## Why

The web UI hard-coded Renovate's "Dependency Dashboard" title to hide that issue and to count the Issues badge. A second client would show a different count. Found by the audit against `rules/frontend.md` (alrayyes/dotfiles#705), ticketed as [alrayyes/forge-dashboard#980](https://github.com/alrayyes/forge-dashboard/issues/980).

## What Changes

- Each issue in `GET /api/dashboard` carries `housekeeping`, set by the server.
- The response carries `openIssueCount`, the issues that are real work.
- The page reads both and holds no copy of the title.

## Capabilities

### Modified Capabilities

- `dashboard-filtering`: which issues count as housekeeping is decided by the server.
