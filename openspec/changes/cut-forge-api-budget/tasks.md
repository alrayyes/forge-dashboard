# Tasks

One pull request per group, in this order. Each group is its own ticket (named in the heading); the PR says `Closes #N`, sits on the milestone "Cut forge API budget", and carries a before/after table from the stats endpoint once group 1 has landed. Tests come first (red, then green, then refactor). Read `design.md` before starting; the decisions are D1 to D8 there. Rules for every group: no user id in any key, table, label or bucket; OpenAPI spec before handler; update the docs in the same commit that makes them false.

## 1. Measure first (#2008)

- [x] 1.1 Add `internal/apistats` with `Counters`, `WithKind` / `WithRepo` context helpers and the kinds from the spec. Failing unit test first: counting a REST call, a GraphQL call with cost, and a 304 under `{forge, credential, kind, repo}`. Verify: `go test ./internal/apistats/...`.
- [x] 1.2 Hook the GitHub client: read kind and repo from `ctx` in `recordRequest` / `recordRESTSuccess` / the GraphQL cost path, and count 304s in `etagTransport`. Verify: a client test against an `httptest` server asserts the counter rows for one GraphQL call and one cached REST GET.
- [x] 1.3 Hook the Forgejo client at its single request point. Verify: a client test asserts REST counts and zero GraphQL.
- [x] 1.4 Set the kind inside the work, not from a request context (coalesced runs and debounced callbacks outlive it): where each refresh starts: `refreshOnce` (`full`), `triggerRefresh` (`scoped_webhook`), `PollCI` (`ci_poll` / `auto_merge_poll`), the details loaders (`details`), webhook ensure / upgrade / check (`hook_maintenance`), the merge, update-branch, rebase and close handlers (`user_action`). Verify: a test fails on any recorded request with kind `unknown`.
- [x] 1.4b Add tests for the remaining stats scenarios: counters are zero with `since` set right after a start; two refreshes on one credential add to the same row; a failing counter write doesn't change a request's result.
- [x] 1.5 Declare `GET /api/stats/forge-api` in the OpenAPI spec first, add a failing contract test (`internal/api`), then the handler behind the existing auth. Regenerate the SDKs the way the repo does for API changes. Verify: `bun run lint:api`, the contract test, and a 401 test without a session.
- [ ] 1.6 Record the baseline on the 30+ repo account (one hour of normal use, one forced full refresh; snapshot the stats endpoint, then restart and note the first refresh's cost from the request log, since counters reset on restart) and put the table in `docs/rate-limits.md` with a "reading the stats" note. Verify: the table is in the PR with the date and repo count.
- [x] 1.7 Replace `ARCHITECTURE.md`'s "read-only" statements (the MCP bullet near line 68 and "Read-only against both forges" near line 130; search for "read-only") with what is true today (merge, update branch, rebase, close). Verify: re-read the file top to bottom.

## 2. Debounce scoped webhook refreshes (#2009)

- [ ] 2.1 Failing tests with a fake clock for the four spec scenarios (10 events → one refresh; 8 s of events → refresh at 5 s; two repos → one each; lone event → at 2 s). Assert the number of `FetchRepo` calls. Verify: tests fail for the right reason.
- [ ] 2.2 Implement `internal/dashboard/debounce.go` (D3) and route `triggerRefresh` through it; `RefreshNow`, force refresh and user actions bypass it. Verify: the tests pass; `go test -race ./internal/dashboard/...`.
- [ ] 2.2b Add the missing scenario tests: a ping delivery (no repo) falls back to a full refresh with no wait; events for two users on one repo each refresh (the debouncer is per `Aggregator`). Verify: the tests pass.
- [ ] 2.3 Add an e2e or integration test that posts 10 signed webhook deliveries for one repo and asserts one scoped refresh in the stats. Verify: `bun run test:e2e` for that spec.
- [ ] 2.4 Update `docs/webhooks.md` (the delay) and `docs/rate-limits.md` (webhook bullet). Verify: before/after of `scoped_webhook` calls in the PR.

## 3. Batch the CI and auto-merge polls (#2010)

- [ ] 3.0 Extend the hook probe: `hookProbe` carries the hook's `events`; add `webhook_seen(forge, credential, repo, event_class, last_seen_at)` in memory, written by `triggerRefresh` per event class (`check`, `pull_request`, `other`). Failing tests first: a comment event doesn't mark check deliveries as seen. Verify: `go test ./internal/github/... ./internal/api/...`. Do not reuse `webhook_deliveries` (it has a user id column).
- [ ] 3.1 Add the `PendingCheckRefresher` interface to `internal/dashboard/source.go` (D4). Failing test: with a fake source, `PollCI` over pending PRs in 12 repos makes one `RefreshPending` call.
- [ ] 3.2 Implement the GitHub aliased query with chunking and merge the result through the same path `RefreshRepo` uses. Verify: client tests for 1, 12 and 60 pending PRs (chunk count asserted) and for one alias erroring (the others are used, the failed one falls back to a per-repo refresh and is logged) against a fake GraphQL server. Add a test that a spent forge makes no request through this path.
- [ ] 3.3 Keep the per-repo fallback for a Source without the interface (Forgejo). Verify: the existing `ci_poll_test.go` cases still pass unchanged.
- [ ] 3.4 Add `pendingSchedule` with the growing interval and the 15-minute cap; reset on state change. Verify: a fake-clock test of the growth and the reset.
- [ ] 3.5 Record webhook deliveries per repo (`lastDelivery`) and skip a repo whose hook is confirmed with check events while deliveries are on time; poll when overdue. Choose the overdue constant from the stats and say which in the PR. Verify: tests for healthy, overdue, no hook, and Forgejo (never skipped).
- [ ] 3.6 Update `docs/configuration.md` (`CI_POLL_INTERVAL`) and `docs/rate-limits.md`. Verify: before/after `ci_poll` and `auto_merge_poll` numbers in the PR.

## 4. Incremental full refresh (#2011)

- [ ] 4.1 Spike on the fixture repo ([#950](https://github.com/alrayyes/forge-dashboard/issues/950)): which of `pushedAt`, `updatedAt`, open PR and issue counts move on a push, a label, a review, a finished check, a comment. Write the result on #2011. Verify: a table of change type vs signal on the ticket. If no cheap probe sees label, review or check changes, record the fallback (rely on webhooks; unhealthy-hook repos always fetched; every Nth full refresh is a full pass) and continue.
- [ ] 4.2 Add the `ChangeProber` interface and failing tests: nothing changed → zero per-repo queries; two changed → two fetched; repo without a healthy hook → fetched; probe error → everything fetched; force refresh → everything fetched.
- [ ] 4.3 Implement the GitHub probe and `FetchRepos(names)`; make `refreshOnce` probe, fetch the changed set, and carry unchanged rows over using the existing `carryOver` / `keepFailedRepos` logic. Verify: the tests pass and `refresh_race_test.go` / `refresh_repo_test.go` still pass.
- [ ] 4.4 Trim the GraphQL selections: list every field in `reposQueryTemplate` and `repoQueryTemplate`, remove the unused ones, add a test that fails if a selected field has no reader. Verify: the test, and `cost` before/after in the PR.
- [ ] 4.5 Add the full pass on the first refresh after a start and on every 6th safety-net refresh (always, not only if 4.1 requires it). Verify: tests that the first refresh after a start and the 6th both fetch every repo.
- [ ] 4.5b For a skipped repo, carry over its rows whole (pull requests, issues, main-branch row), keep `checkWebhooks` running as a conditional call, and advance the issues `since` marker only for repos actually fetched. Verify: a test that an unchanged repo's main-branch row and issues are intact after an incremental refresh.
- [ ] 4.6 Update `docs/rate-limits.md`. Verify: before/after `full` numbers on an unchanged account.

## 5. Conditional requests everywhere (#2012)

- [ ] 5.1 List every REST GET in `internal/github` and `internal/forgejo` in a table in the PR (cached / not cached and why). Verify: the table covers a grep of all GET call sites.
- [ ] 5.2 Close the GitHub gaps (installation repo list, webhook checks, anything outside `etagTransport`). Failing test first: a second call is a 304 and counted as one.
- [ ] 5.3 Forgejo: confirm against a real instance whether the PR details and check endpoints honour `If-None-Match`; if yes add a Forgejo ETag transport keyed by credential; if no record that on #2012 and in `docs/rate-limits.md`. Verify: the recorded result and, when supported, a client test.
- [ ] 5.4 Key cache entries by forge, credential and URL (D6), not the `Client` instance. Verify: a test that a replaced credential doesn't send the old ETags.
- [ ] 5.5 Update `docs/rate-limits.md` ("A restart" bullet will change in group 6). Verify: before/after 304 counts.

## 6. Persist the cache (#2013)

- [ ] 6.1 Add the `http_etags`, `snapshot_cache` and `hook_checks` tables to `internal/settings` with a schema-version check. Verify: store tests with a temp database for write, read, prune, size cap and eviction.
- [ ] 6.2 Give `etagTransport` an optional store (read-through, write on 200 with ETag, per-body and total caps). Verify: a test that a second `Client` over the same store sends `If-None-Match` for a URL the first cached.
- [ ] 6.3 Persist the snapshot after each successful refresh and load it at `Manager` start, marked stale until the first refresh succeeds; reuse the existing stale field and add an API field only spec-first. Verify: a restart test shows the stale snapshot served, then cleared.
- [ ] 6.4 Persist the webhook-check results (with hook events) and `webhook_seen`. Verify: a test that coverage computed after a restart equals before.
- [ ] 6.5 Corrupt or old-schema rows → start empty and log. Verify: a test with garbage rows.
- [ ] 6.6 Update `docs/configuration.md` (where the data lives), `docs/rate-limits.md` (rewrite "A restart"), and #381's note. Verify: before/after of the first refresh after a restart.

## 7. Webhook-aware interval (#2014)

- [ ] 7.1 Add `coverage` computed from `hook_checks` and `lastDelivery` (every tracked repo has a healthy hook; an overdue delivery makes it unhealthy). Failing tests first.
- [ ] 7.2 Replace the bare timer in `Run` with the `scheduler` (D7): stretched interval when covered (`min(4 * REFRESH_INTERVAL, max(2h, REFRESH_INTERVAL))`, so 80 minutes at the default), `REFRESH_INTERVAL` otherwise, still passing through `NextRefreshDelay`. Verify: tests for both transitions with a fake clock; the existing `NextRefreshDelay` tests unchanged.
- [ ] 7.3 Treat an explicit `REFRESH_INTERVAL` as the lower bound. Verify: a `cmd/forge-dashboard` test.
- [ ] 7.4 Update `docs/configuration.md` and `docs/rate-limits.md`. Verify: `full` refresh count per day before/after.

## 8. Reserve budget for user actions (#2015)

- [ ] 8.1 Failing tests: a background full refresh or poll that would cross the reserve waits; a scoped webhook refresh runs until the budget is spent; a user Merge / Update branch / rebase / Close / Enable auto-merge / queued action runs; a force refresh runs unless the budget is spent; Forgejo is never held.
- [ ] 8.2 Add `budgetAllows(kind)` (reserve `10%` of the limit, floor 50) and call it from the background paths only, for both the REST and GraphQL budgets. Verify: the tests pass; `rate_limit_*_test.go` and `refresh_exhausted_forge_test.go` unchanged.
- [ ] 8.3 Document that the reserve is GitHub-only and how to change it (constant or setting, decided in the PR). Update `docs/rate-limits.md` and `docs/configuration.md`. Verify: re-read both.

## 9. Idle mode (#2016)

- [ ] 9.1 Failing tests with a fake clock: idle for the period → the scheduled refresh doesn't run; first request after → one incremental refresh; a webhook during idle still refreshes; an SSE stream alone does not count as activity (pin whichever rule the PR chooses and say why); a forced refresh during idle runs immediately.
- [ ] 9.2 Add the `activity` tracker as middleware at the composition root, touched by session and API-token requests; give `Run` an idle check. Verify: the tests pass; `go test -race ./...`.
- [ ] 9.3 Update `docs/configuration.md` and `docs/rate-limits.md`. Verify: `full` refreshes over a night of idle, before/after.

## 10. Reconcile and close out (#2017)

- [ ] 10.1 Tick the shipped tasks in `openspec/changes/github-api-rate-limit-mitigation/tasks.md` against #381, #408, #1170 and note any not shipped. Verify: `openspec status --change github-api-rate-limit-mitigation`.
- [ ] 10.2 Sync or archive that change (and the other changes listed complete by `openspec list`, only if their own tickets agree). Verify: `openspec list` no longer shows it in progress.
- [ ] 10.3 Write the final before/after table (baseline vs end state, per refresh type) into `docs/rate-limits.md` and the umbrella #2007. Verify: the table is in both.
- [ ] 10.4 Add an "adding a forge" section to `ARCHITECTURE.md` from D8. Verify: re-read.
- [ ] 10.5 Run `go test ./...`, `bun run test:e2e`, `bun run check:web`, `bun run lint:js`, `bun run lint:api`, all green.

## Workflow follow-up

- Archive this change once every group has merged: `openspec archive cut-forge-api-budget`, then close #2007 referencing the PRs.
- File a ticket for the GitLab spike (verify webhooks, GraphQL cost, ETags) only if GitLab support is decided.
