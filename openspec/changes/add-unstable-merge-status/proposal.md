# Proposal

## Why

GitHub reports a pull request as UNSTABLE when it can merge but a check that branch protection doesn't require is failing or running. The dashboard mapped that to blocked and disabled Merge, which GitHub itself doesn't. Found by the fixture harness in [alrayyes/forge-dashboard#950](https://github.com/alrayyes/forge-dashboard/issues/950), ticketed as [alrayyes/forge-dashboard#955](https://github.com/alrayyes/forge-dashboard/issues/955) and [alrayyes/forge-dashboard#956](https://github.com/alrayyes/forge-dashboard/issues/956).

## What Changes

- `MergeStatus` gains `unstable`, mapped from GitHub's UNSTABLE. The OpenAPI enum changes with it.
- Merge stays available on an unstable pull request, whatever the CI rollup says. A required check failing or running makes GitHub report BLOCKED, so the existing rules still hold there.

## Capabilities

### Modified Capabilities

- `pr-merge-status`: an unstable status, and Merge staying open on it.
