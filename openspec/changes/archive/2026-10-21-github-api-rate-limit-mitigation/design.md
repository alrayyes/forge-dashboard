# Design

## Context

See proposal.md - Why. `defaultRefreshInterval` (`cmd/forge-dashboard/main.go`) is 5 minutes, set when polling was the only way any update reached the dashboard. Every tracked repo now has a webhook (set up directly this session, all 41 repos this account tracks), which already triggers an immediate refresh on a real event via `handleGitHubWebhook`/`handleForgejoWebhook`. GitHub's GraphQL API has no HTTP-level conditional-request mechanism (confirmed via research) — every call costs its documented minimum of 1 point per nested connection per parent page, so `reposQueryTemplate`'s two nested connections (`pullRequests`, `issues`) per repo cost a real floor on every poll regardless of whether anything changed. REST calls this client makes do support ETag/If-None-Match, unused today.

## Goals / Non-Goals

**Goals:**

- Meaningfully cut steady-state GitHub API consumption without weakening how fast a real change (webhook-triggered) reaches the dashboard.
- Make the periodic poll behave like a reconciliation safety net, not the primary update channel it was originally built as.

**Non-Goals:**

- No change to the webhook-triggered refresh path itself — that stays exactly as fast as it is today.
- No `search`-API-based delta fetching for pull requests — GitHub's `pullRequests` connection has no `since`-style filter, and using `search` instead would mean restructuring `fetchViaGraphQL`'s whole per-repo nested-query shape into a flat cross-repo query. Real, but a separate, larger change.
- No cross-user coordination or shared cache between different forge-dashboard users' polls — each user's token and budget are already independent; nothing here changes that isolation.

## Decisions

**Raise the default interval, don't remove the poll.** Standard webhook-plus-reconciliation practice keeps polling as the backup for a missed webhook delivery, on a materially longer interval (15–60 minutes) than a system relying on polling alone would use. 15–30 minutes is chosen over the top of that range to keep the safety net reasonably tight, still a 3–6x reduction in raw poll frequency from today's 5 minutes.

**`since` filtering only on issues, explicitly not attempted on pull requests.** Confirmed via research that `IssueFilters.since` exists on GitHub's schema and `PullRequestFilters` has no equivalent — applying this asymmetrically (issues get it, pull requests don't) is the honest reflection of what the API actually supports, not a workaround or a compromise to paper over.

**Track "last successful poll time" per user**, needed to supply `since` — this is new state the aggregator doesn't currently keep (today it only tracks the latest snapshot, not when it was last successfully fetched). Stored in memory alongside the existing per-user `Aggregator` state, not persisted — losing it across a restart just means the next poll after a restart re-fetches everything once, which is already today's behavior on every poll.

**ETag caching is per-client, in-memory, keyed by request URL** — the standard shape for this (cache the `ETag` response header, send it back as `If-None-Match` next time, treat a 304 as "use the cached body"). Scoped to this client's own REST calls only; GraphQL gets no equivalent since GitHub doesn't support one there.

**Backoff triggers off the already-tracked `RateLimit.Remaining`**, not a new signal — `ForgeHealth.RateLimit` is already populated from every GraphQL response. When remaining drops below a threshold (e.g. under 5% of the limit), the next scheduled refresh is pushed back rather than firing immediately, using the `ResetsAt` timestamp already available to know how long to wait.

## Risks / Trade-offs

- **A longer poll interval means a missed webhook delivery (network blip, forge-side failure) goes unnoticed for longer.** → Mitigation: 15–30 minutes is still well inside the range the research found standard for exactly this reconciliation role; a manual "Refresh now" remains available for anyone who notices staleness before the next tick.
- **In-memory ETag cache and last-poll-time are both lost on a process restart.** → Mitigation: acceptable — the very next poll after a restart just behaves like today's poll always does (full re-fetch), a one-time cost, not a regression from current behavior.
- **Backoff could compound with a user who has a very small remaining budget for other reasons** (e.g. concurrent script usage against the same token) **and end up polling rarely enough that it feels broken.** → Mitigation: cap the maximum backoff delay so it never exceeds the time until `ResetsAt` plus a small buffer, ensuring it always recovers to normal cadence once the budget actually resets.

## Migration Plan

Additive and backward-compatible — `REFRESH_INTERVAL` still works exactly as before if a user has set it explicitly; only the unset default changes. No data migration; the new per-user "last poll time"/ETag state starts empty and fills in naturally.
