# Proposal

## Why

The dashboard offers Merge on a draft GitHub pull request that GitHub reports as clean. GitHub's merge API refuses it with 405 "Pull Request is still a draft". Found by the fixture harness in [alrayyes/forge-dashboard#950](https://github.com/alrayyes/forge-dashboard/issues/950), ticketed as [alrayyes/forge-dashboard#957](https://github.com/alrayyes/forge-dashboard/issues/957).

## What Changes

- Merge is blocked on every draft pull request, whatever mergeable state the forge reports.

## Capabilities

### Modified Capabilities

- `pr-merge-status`: a draft pull request never offers Merge.
