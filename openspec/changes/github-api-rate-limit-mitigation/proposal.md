# Proposal

## Why

The background refresh loop spends GitHub API budget as if polling were the only way updates ever arrive, even now that every tracked repo has a webhook — a normal-sized set of tracked repos can run into rate-limit errors during ordinary use. See [alrayyes/forge-dashboard#381](https://github.com/alrayyes/forge-dashboard/issues/381).

## What Changes

- The default background refresh interval increases from 5 minutes to a webhook-reconciliation-appropriate interval (15–30 minutes), still overridable via the existing `REFRESH_INTERVAL` environment variable.
- The issues half of the GraphQL query passes `filterBy: { since: <last successful poll time> }` on repeat polls, instead of unconditionally re-fetching every open issue's full data each time.
- This client's own REST calls (`checkWebhooks`'s hook listing, the anonymous/no-token REST fallback) gain ETag-based conditional request caching, so an unchanged resource costs zero quota on a repeat call.
- When the last known `RateLimit.Remaining` is critically low, the next scheduled refresh is delayed rather than firing on a fixed timer into an already-exhausted budget.

## Capabilities

### New Capabilities

- `background-refresh-scheduling`: how and when the background refresh loop runs, including its default interval and its response to a low remaining rate-limit budget.

### Modified Capabilities

(none — `dashboard-force-refresh` covers the separate, user-triggered immediate refresh path and isn't changed by this)

## Impact

- `cmd/forge-dashboard/main.go`: `defaultRefreshInterval` value.
- `internal/github/client.go`: issues query gains `since` filtering; REST calls gain ETag caching.
- `internal/dashboard`: the scheduling/backoff logic for the refresh loop.
- Explicitly out of scope: applying an equivalent delta filter to pull requests, which has no `since`-style filter on GitHub's `pullRequests` connection and would need the separate `search` API and a real query restructuring — tracked as a future follow-up, not attempted here.
