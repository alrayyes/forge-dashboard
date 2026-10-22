# Proposal

## Why

A refresh spends forge API budget as if every repo had changed. A push to one repo can fire four webhook events and four refreshes. The CI and auto-merge poll queries one repo at a time, every minute, for as long as a pull request stays armed. The safety-net full refresh re-reads every repo whether or not anything moved. A restart throws away every ETag and the snapshot, so the first refresh pays in full. None of it is measured, so no one can say which of these costs most.

The work is for the open-source, single-user version. An enterprise version is planned and will reuse it, so caches, stats and budgets are keyed by credential and repo, never by user. Billing, tenant isolation and per-customer budgets are not part of this change. Tracked as the umbrella [forge-dashboard#2007](https://github.com/alrayyes/forge-dashboard/issues/2007).

## What Changes

- **Measure first** ([#2008](https://github.com/alrayyes/forge-dashboard/issues/2008)): count REST calls, GraphQL cost and 304s per refresh type and per repo, expose them on an internal stats endpoint, and record a baseline on a 30+ repo account.
- **Debounce** ([#2009](https://github.com/alrayyes/forge-dashboard/issues/2009)): a webhook-triggered scoped refresh waits a trailing 2 s per repo, capped at 5 s for one burst, so a burst causes one refresh. **BREAKING** for the old promise that the webhook path "stays exactly as fast"; a lone event now waits up to 2 s.
- **Batch the CI and auto-merge polls** ([#2010](https://github.com/alrayyes/forge-dashboard/issues/2010)): one aliased GraphQL query for all pending PRs, a growing interval for PRs pending a long time, and no polling for a repo whose webhook is confirmed to include check events unless a delivery is overdue.
- **Incremental full refresh** ([#2011](https://github.com/alrayyes/forge-dashboard/issues/2011)): a cheap probe finds the repos that changed since the last snapshot and only those are fetched in full. The GraphQL selection is trimmed to fields the UI and API use.
- **Conditional requests on every REST read** ([#2012](https://github.com/alrayyes/forge-dashboard/issues/2012)), including Forgejo's PR details and checks.
- **Persist the cache** ([#2013](https://github.com/alrayyes/forge-dashboard/issues/2013)): ETags, the last snapshot and the webhook-check results survive a restart; the snapshot is served marked stale until the first refresh succeeds. **BREAKING** for the earlier note that losing the cache on restart is acceptable.
- **Webhook-aware interval** ([#2014](https://github.com/alrayyes/forge-dashboard/issues/2014)): the full refresh stretches (20 min to 2 h) while every tracked repo has a healthy webhook.
- **Reserve budget for user actions** ([#2015](https://github.com/alrayyes/forge-dashboard/issues/2015)): background work stops short of a reserve so Merge and Update branch can still run. Spreading refreshes across the window is deferred.
- **Idle mode** ([#2016](https://github.com/alrayyes/forge-dashboard/issues/2016)): background refreshes slow or pause when nothing has used the dashboard for a while; one incremental refresh catches up on return.
- **Reconcile** ([#2017](https://github.com/alrayyes/forge-dashboard/issues/2017)) the stale `github-api-rate-limit-mitigation` change.
- Docs: `docs/rate-limits.md`, `docs/configuration.md`, `docs/webhooks.md` and `ARCHITECTURE.md` (which still says read-only) are corrected in the PR that makes each one false.

## Capabilities

### New Capabilities

- `forge-api-usage-stats`: counters of forge API spend by refresh type, repo and credential, and the endpoint that serves them.
- `webhook-refresh-debounce`: how a burst of webhook events for one repo turns into one scoped refresh.
- `pending-check-polling`: how pending CI and armed auto-merge are polled, batched and backed off.
- `incremental-refresh`: how the full refresh decides which repos to fetch.
- `refresh-cache`: conditional requests, and what survives a restart.
- `refresh-budget-scheduling`: the adaptive interval, the user-action reserve and idle mode.

### Modified Capabilities

- `dashboard-force-refresh`: a user's "Refresh now" bypasses the debounce, the idle pause and the reserve.

## Impact

- `internal/dashboard`: `aggregator.go` (`Refresh`, `RefreshRepo`, `PollCI`, `Run`, `RunCIPoll`, `NextRefreshDelay`), `coalesce.go`, `service.go`, `source.go` (new optional capability interfaces).
- `internal/github`: `client.go` (`fetchViaGraphQL`, `checkWebhooks`, `FetchRepo`, `graphqlDo`, `recordRequest`), `etag_transport.go`.
- `internal/forgejo`: `client.go`, `pull_request_details.go`.
- `internal/api`: `webhooks.go` (`triggerRefresh`), a new stats handler and its OpenAPI path under `api/`, and generated SDKs.
- `internal/settings`: new SQLite tables, keyed by credential and repo.
- New package `internal/apistats`.
- Depends on, and must not collide with, the single-user cleanup in [#1876](https://github.com/alrayyes/forge-dashboard/issues/1876): the admin-only request-log endpoints are going away, and the per-user `Manager` it describes is now the single-aggregator `Service`.
- Docs and OpenAPI as above. No new third-party dependency.
