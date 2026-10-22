# Design

## Context

See proposal.md for why. The code this touches, as it is today:

- `internal/dashboard/aggregator.go`: `Refresh` runs `refreshOnce` through a `coalescer` (`coalesce.go`) that merges _concurrent_ runs into one trailing run. `RefreshRepo` is the scoped path, with a per-repo keyed coalescer. `Run` is a single timer: `Refresh`, then `NextRefreshDelay` (low-budget back-off only). `RunCIPoll` is a fixed ticker (`CI_POLL_INTERVAL`, default 1 minute) calling `PollCI`, which calls `RefreshRepo` once per repo that has a pending-CI or armed-auto-merge PR. `exhaustedHealth` already skips a spent forge.
- `internal/api/webhooks.go`: `handleGitHubWebhook` and `handleForgejoWebhook` answer 204 and run `go triggerRefresh(...)`, which calls `service.RefreshRepo` and falls back to `service.RefreshNow`.
- `internal/dashboard/service.go`: one `Aggregator`, started in `startLocked` (it replaced the per-user `Manager` when the app went single user, [#1876](https://github.com/alrayyes/forge-dashboard/issues/1876)); this change must not add per-user plumbing.
- `internal/dashboard/source.go`: optional capabilities by type assertion (`RepoRefresher`, `MainBranchRefresher`, `WebhookChecker`, `RateLimiter`). New capabilities here follow that pattern.
- `internal/github/client.go`: `fetchViaGraphQL` (one account-wide query with `rateLimit { cost }`, `filterBy.since` on issues, then `checkWebhooks` with one REST `ListHooks` per repo, then `reconcileIssues`, `withCheckedCommits`, `resolveAmbiguousBehind`, `settleUnreportedRequiredChecks`). `FetchRepo` is the single-repo query. `graphqlDo` and the REST wrappers call `recordRequest` / `recordRESTSuccess`, which write `requestlog.Entry` rows (the outbound request log: `internal/requestlog`, capped at 10,000 rows, `AccountID` field, endpoints that were admin-only before the single-user cleanup).
- `internal/github/etag_transport.go`: `etagTransport`, a per-`Client`, in-memory map keyed by URL, GET only. GitHub folds the Authorization header into its ETag, so entries are only valid for one credential.
- `internal/forgejo` is a `GenericSource`: one REST call per repo, no GraphQL, no budget reported.
- SQLite via `modernc.org/sqlite` is already open for `settings.Store` (`internal/settings/store.go`, tables created with `CREATE TABLE IF NOT EXISTS` plus an additive-column pass).
- `docs/configuration.md`: `REFRESH_INTERVAL` default `20m`, `CI_POLL_INTERVAL` default `1m`.

Earlier decisions this change touches: #381 and its OpenSpec change (`github-api-rate-limit-mitigation`, stale, reconciled by #2017). This change reverses two earlier choices on purpose: #381's "the webhook path stays exactly as fast" (the debounce adds latency) and that change's design note that losing the ETag cache on restart is acceptable (`openspec/changes/github-api-rate-limit-mitigation/design.md`, Risks).

## Goals / Non-Goals

**Goals:**

- Fewer forge API calls per refresh, shown by numbers in every PR against a recorded baseline.
- Policy that is forge-neutral and mechanism that is per forge, so Forgejo today and GitLab later plug in without rework.
- Every cache, counter and budget keyed by credential and repo, so a hosted version can share them.

**Non-Goals:**

- Billing, tenant isolation, per-customer budgets, shared caches across customers.
- Spreading refreshes across the window. Deferred until the stats show bursts that hurt.
- GitLab support. Only the shape that lets it fit.
- Changing what the page shows. Only how often and how cheaply the data is fetched.

## Decisions

### D1. Forge-neutral policy, forge-specific mechanism

The debounce, back-off schedule, interval policy, idle logic, reserve policy and persistence live in `internal/dashboard` and know no forge. Anything that needs a forge's API is an optional interface next to `RepoRefresher`, found by type assertion; a Source without it gets today's behaviour.

```
        internal/dashboard  (policy, neutral)
  +-----------------------------------------------+
  | debounce | backoff | interval | idle | reserve |
  +----------------------+------------------------+
                         | optional interfaces
        +----------------+-----------------+
        v                v                 v
   PendingCheckRefresher  ChangeProber   RateLimiter (exists)
   (batch pending PRs)    (what changed)  (budget)
        |                |                 |
   github: aliased   github: repo list    github: headers
   GraphQL           updatedAt/pushedAt   forgejo: none
   forgejo: absent   forgejo: absent      gitlab: headers (to verify)
   gitlab: to verify gitlab: to verify
```

Alternative rejected: a fat `Forge` interface every Source must implement. It forces Forgejo to stub methods it can't honour and hides which capability is missing.

### D2. Stats are a small in-process aggregate, not queries over the request log

New package `internal/apistats`. A `Counters` value holds a map keyed by `{forge, credential, kind, repo}` with counts `rest`, `graphql`, `graphqlCost`, `notModified`. The refresh type travels in the `context.Context`: `apistats.WithKind(ctx, kind)` and `apistats.WithRepo(ctx, repo)` are set where a refresh starts (`refreshOnce` → `full`, `RefreshRepo` called from `triggerRefresh` → `scoped_webhook`, `PollCI` → `ci_poll` or `auto_merge_poll`, the PR details loaders → `details`, `EnsureWebhook`/`UpgradeWebhook`/`checkWebhooks` → `hook_maintenance`, the merge/update/rebase handlers → `user_action`). The GitHub and Forgejo clients read the kind and repo from `ctx` in the same place they already call `recordRequest`, so there is one hook point per client, not a call at every site. Kind must be set _inside_ the work, not copied from a request: the coalescer runs a merged run under the first caller's `ctx`, and a debounced callback outlives the request that scheduled it, so `refreshOnce`, `RefreshRepo`'s callback and the debouncer's callback each call `WithKind` themselves. A missing kind counts as `unknown`, which a test treats as a failure so a new call site can't go unlabelled.

- Credential label: GitHub token mode uses the stored account id; App mode uses the installation id. It is never the user id. Add the credential at the client constructor.
- Why not reuse `request_log`: it is capped at 10,000 rows (a day of polling can exceed it), is a per-request row log, has no refresh-type or repo column, and its admin-only endpoints are going away with the single-user cleanup. It stays as the raw log; the stats are the aggregate. Alternative considered: add `kind` and `repo` columns to `request_log` and `GROUP BY`. Rejected for the cap.
- Endpoint: `GET /api/stats/forge-api` (name final in the OpenAPI spec; spec first, then a failing contract test, per ADR 0001). Returns `{since, buckets: [{forge, credential, kind, repo, rest, graphql, graphqlCost, notModified}], budgets: [...]}`. Reuses the existing auth middleware; it is not behind an admin check, since the admin area is gone. The `Service` holds one aggregator, so the handler returns the buckets for its credential(s). Regenerate the client SDKs the way the repo already does for any API change.
- The PR template for this work carries a before/after table built from this endpoint.
- Baseline: record on the 30+ repo account over a fixed window (suggest one hour of normal use, plus one forced full refresh and one restart) and store the table in `docs/rate-limits.md`. If no such account exists on the day, the fixture repo from [#950](https://github.com/alrayyes/forge-dashboard/issues/950) is the fallback and the PR says so.

### D3. Debounce: a per-repo trailing timer in front of `RefreshRepo`

`internal/dashboard/debounce.go`: a `debouncer` owned by each `Aggregator` (so it is per instance), keyed `forge + "/" + fullName` with `quiet = 2 * time.Second` and `maxHold = 5 * time.Second` as unexported constants. `Submit(key, fn)` starts a timer on the first event, resets it on each later one up to `maxHold` after the first, then runs `fn` once and clears the entry. The clock is injected (the aggregator already has `WithClock`) so tests use a fake. It is called from `triggerRefresh` only; `RefreshNow`, force refresh, queued actions and user actions bypass it. The existing keyed coalescer stays behind it, so a refresh that overlaps still merges.

Alternatives: leading-edge (rejected: the first event of a burst still fires alone, so a push costs two refreshes); a global window (rejected: it would delay unrelated repos). The cap exists so a chatty repo can't starve its own refresh.

Shutdown: pending timers are dropped on context cancel; a webhook that was acknowledged but not yet refreshed is only recovered by the periodic full pass (D5), because incremental refreshes skip healthy-hook repos. So the first refresh after a start is always a full pass, and `docs/webhooks.md` says an event acknowledged during shutdown can wait for the next full pass.

### D4. Batched pending-check poll

New optional interface in `source.go`:

```go
type PendingCheckRefresher interface {
    RefreshPending(ctx context.Context, refs []PullRequestRef) ([]PullRequest, error)
}
```

GitHub builds one query with an alias per pull request (`pr0: repository(owner:..., name:...) { pullRequest(number:...) { ...ci fields, autoMergeRequest, mergeable, state } }`), splitting into chunks if the node count would exceed GitHub's limit. The result is merged per repo with the same `mergeRepo` path `RefreshRepo` uses, so ordering and settle-window behaviour stay identical. A Source without it falls back to `RefreshRepo` per repo. One alias failing (a deleted repo, an uninstalled one, a PR that merged meanwhile) comes back as a partial `errors` entry for that alias and must not fail the poll: the other aliases are used, and the failed ones go to a one-off per-repo `RefreshRepo` fallback and are logged.

`PollCI` changes from "every repo with anything pending, every tick" to a schedule held in a small `pendingSchedule` map keyed `forge/repo#number`: `base = CI_POLL_INTERVAL`, doubling per consecutive unchanged poll up to `15m`, reset on a state change. The webhook skip needs two things that do not exist yet. First, hook events: `hookProbe` (`internal/github/client.go`) holds only `has` and `refused`, and `checkWebhooks` keeps no event list, so the probe is extended to carry the hook's `events` (`HasWebhook` stays as is; a new method returns the hook), kept in memory in group 3 and persisted in group 6. Second, delivery times per event class: the existing `webhook_deliveries` table has a `user_id` column and records any event, so a stream of comments would hide failing check deliveries; do not reuse it. A new `webhook_seen(forge, credential, repo, event_class, last_seen_at)` records `check` (check_run, check_suite, status), `pull_request` and `other` separately, in memory first and persisted in group 6; the old table is left for #1876 to remove. The skip uses the webhook-check results (D6): a repo is skipped when its hook is confirmed, subscribes to check events (`check_run` / `check_suite` on GitHub), and a `check`-class delivery for it arrived within the `overdue` period. `overdue` starts at `3 * CI_POLL_INTERVAL` and is a named constant; #2010 confirms or changes it against the stats. A delivery is recorded by `triggerRefresh` as in-memory `webhook_seen` records (persisted with D6). Forgejo: its hook drops the `status` event on real instances (#177), so Forgejo repos are never skipped by this rule.

### D5. Incremental full refresh

New optional interface:

```go
type ChangeProber interface {
    ProbeChanges(ctx context.Context, since Snapshot) (changed map[string]bool, complete bool, err error)
}
```

GitHub probe: a cheap query listing the tracked repos with `updatedAt`, `pushedAt` and the open PR and issue counts (`pullRequests(states: OPEN){ totalCount }`, `issues(states: OPEN){ totalCount }`), compared with the values stored per repo in the snapshot. **Open risk to settle first, as a spike recorded on #2011:** `pushedAt` does not move on a label, a review or a finished check, and `updatedAt` on the repository may not either. If the probe cannot see those, the incremental refresh must lean on webhooks for them and treat a repo without a confirmed healthy webhook as changed (already in the spec). The spike answers it empirically against the fixture repo; if no cheap probe is trustworthy for a class of change, only repos with healthy webhooks are skipped and the rest are fetched as today.

For a repo skipped as unchanged, the rows are carried over whole (pull requests, issues, main-branch row, review and merge-state results), and `checkWebhooks` still runs for it as a conditional REST call, which D6/#2012 make a free 304, so hook health stays current; `reconcileIssues` and `withCheckedCommits` run for changed repos only, and the issues `since` marker advances only for repos actually fetched. `refreshOnce` becomes: probe → build the changed set → call a new `FetchRepos(ctx, names)` for those → merge with `carryOver`-style reuse of unchanged rows. Reuse the existing `keepFailedRepos` / `carryOver` logic for rows that were not refetched. Force refresh passes `full=true` and skips the probe, and so does the first refresh after a start and every Nth safety-net refresh (default every 6th; this is mandatory, not conditional on the spike, because it is what bounds a missed webhook). `complete=false` or an error means fetch everything.

Query trimming is a separate step in the same ticket: list every field in `reposQueryTemplate` and `repoQueryTemplate`, delete the ones no mapper reads, and add a test that fails if the selection contains a field no mapper uses. Cite the GraphQL cost rules when explaining the saving.

### D6. Persistence in the existing SQLite database

Four tables created with `CREATE TABLE IF NOT EXISTS` alongside the existing ones in `internal/settings`, none with a user id:

- `http_etags(forge, credential, url, etag, body BLOB, header_json, updated_at)` with primary key `(forge, credential, url)`. `etagTransport` gets an optional store: read-through on start (lazily per key), write on a 200 with an ETag. Cap total size (suggest 20 MB, oldest evicted) and cap per-body size; bodies over the cap are not stored.
- `snapshot_cache(forge, credential, repo, payload_json, fetched_at)` holding each repo's rows; written after a successful refresh, loaded by `Service` start so `Get()` returns it with `Stale=true` until the first refresh succeeds. The stale mark already exists for failed repos (`markRepoStale`); reuse that field rather than inventing a second one, and add a snapshot-level flag only if the API needs one (spec first).
- `hook_checks(forge, credential, repo, has_hook, events_json, refused, checked_at)` for D4. D7 reads the snapshot's live `HasWebhook`, which these checks feed, and does not use delivery times.
- `webhook_seen(forge, credential, repo, event_class, last_seen_at)` for D4: the last delivery per event class, so the CI poll skip survives a restart.

A schema version check and a tolerant loader: unreadable rows are logged and the cache starts empty (the spec's corrupt-store scenario). Retention: delete rows for repos no longer tracked on each successful full refresh.

Authorization-folded ETags: a rotated installation token makes one miss (already documented in `etag_transport.go`); keying by credential identity rather than token value means rows survive an hourly rotation, and the miss is harmless. If GitHub rejects a stale ETag with a 200, it simply replaces the row.

### D7. Scheduling: interval, reserve, idle

The `Aggregator.NextDelay` method in `internal/dashboard` replaces the bare timer in `Run`:

- `NextDelay(interval)` = max(`NextRefreshDelay` today, interval) where `interval` is `REFRESH_INTERVAL` when coverage is not full, else `min(stretchFactor * REFRESH_INTERVAL, max(2h, REFRESH_INTERVAL))` with `stretchFactor = 4`, so the default `20m` stretches to 80 minutes and a larger explicit value is never shortened (the previous wording stretched nothing at the default). Coverage is "at least one tracked repo, and every tracked repo has `HasWebhook` true" from the current snapshot (ignored repos stay in it), so it needs D6 first: the persisted checks seed `HasWebhook` after a restart.
- Reserve: constant `reserveFraction = 0.10` of the budget (min 50 points), applied to background callers only: full refreshes, polls and hook maintenance. A scoped webhook refresh is held only when the budget is spent, since it is cheap and is the path the plan wants to keep. The check is `remaining - lastCostOfThisKind > reserve`, so a full refresh that would cross the reserve waits, not just one that starts under it. User actions are Merge, Update branch, bot rebases, Close, Enable auto-merge and queued actions; none is gated. The background path asks `budgetAllows(kind)` before a call; user actions never ask. This reuses `RateLimit` from `ForgeHealth`; Forgejo returns nil and so is never held. Document that the reserve is GitHub-only.
- Idle: `activity` tracker records the time of the last browser or API request (middleware at the composition root, touched by session and token requests, **not** by the SSE keep-alive, which is not a user act; an SSE connection existing is recorded separately and pinned by a test, per #2016's third criterion). `idleAfter = 15 * time.Minute`. While idle, `Run` skips its tick and re-arms; the first activity after idle triggers one `Refresh` (incremental by D5). Webhook-triggered refreshes still run (they are the cheap path).
- A force refresh calls the immediate path and ignores all three; it is still subject to the existing 5 s `DefaultForceRefreshCooldown`.

### D8. What other forges need

For Forgejo (today) and GitLab (later) the policy code needs no change. Per forge, a Source implements only the capabilities it honestly can:

| Capability              | Forgejo                                                  | GitLab (to verify)                       |
| ----------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `PendingCheckRefresher` | no (REST only), keeps per-repo fallback                  | possible via GraphQL                     |
| `ChangeProber`          | no, always full for that forge                           | project `last_activity_at` or events API |
| `RateLimiter`           | no budget reported                                       | `RateLimit-*` headers                    |
| Conditional requests    | check `If-None-Match` support on PR and status endpoints | some endpoints send ETags                |
| Webhook check events    | hook drops `status` on real instances (#177)             | pipeline/merge-request events            |

A short "adding a forge" section in `ARCHITECTURE.md` lists these so the next adapter fills the table instead of guessing.

## Risks / Trade-offs

- [Debounce adds up to 2 s to a lone webhook's refresh, and up to 5 s under a burst] → documented in `docs/webhooks.md`; force refresh bypasses it; constants named so they can be tuned from the stats.
- [An incremental refresh misses a change the probe can't see (label, review, check)] → spike first; repos without a healthy webhook are always fetched; the safety-net refresh periodically does a full pass (every Nth, default 6, to be fixed when the spike result is known) so a missed change is bounded.
- [A persisted snapshot shows old data after a long outage] → served stale and marked; replaced on the first successful refresh.
- [ETag rows grow] → size cap, per-body cap, eviction oldest first, pruning of untracked repos.
- [Stretched interval hides a webhook that silently stopped] → coverage is recomputed from the snapshot's live `HasWebhook` at each refresh, and a repo whose hook check fails drops out of "healthy", so the interval returns to `REFRESH_INTERVAL` at the next refresh. Delivery lateness is not used, because a quiet repo sends nothing for days. The worst case is one stretched wait before a lost hook is noticed.
- [Reserve holds back background work on a small budget] → the reserve is a fraction with a floor, and force refresh still runs unless the budget is spent.
- [Collision with #1876, which replaced `Manager` with `Service` and removed the admin area] → stats and cache keys use credential and repo only; rebase on #1876's changes; do not add a user parameter to any new API.
- [Batched query exceeds GitHub's node limit] → chunk the aliases; a test with 60 pending PRs asserts the chunk count.

## Migration Plan

Additive. New tables are created on start; no data migration. Defaults keep behaviour close to today: the stretched interval only applies when every repo is covered. Rollback is removing the new tables' use; nothing else reads them. Every PR is independently revertible, in the order of the tasks. Delete nothing from `request_log`.

## Open Questions

- Which exact probe fields are trustworthy (settled by the #2011 spike; the specs don't change, the probe implementation does).
- The `overdue` multiple for a late webhook delivery (settled with data from the stats during #2010).
- Whether the stats endpoint should also be exposed through the MCP endpoint (`/api/mcp`). Safe to answer later; it doesn't change the specs.
