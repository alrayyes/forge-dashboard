## Context

See proposal.md - Why/What Changes for the motivation. Current shape,
confirmed by reading the code directly:

- `internal/dashboard/manager.go:110-120` — `Manager.RefreshNow(ctx,
userID) bool` is already the exact "force a fetch now" entry point this
  change needs. It blocks until a coalesced pass completes and reports
  `false` if the user has no running `Aggregator` (no credentials saved).
- `internal/api/webhooks.go:179-189` (`triggerRefresh`) is the only
  existing caller today, run in its own goroutine (`go triggerRefresh(...)`)
  with `appCtx` — the app's long-lived context — **not** the webhook
  request's own `r.Context()`, since the handler already responded `204`
  before this runs.
- `internal/dashboard/coalesce.go` (`coalescer.do`) — only the caller that
  finds `running == false` (the "leader") actually invokes `fn`, with
  whatever `ctx` that leader's own closure captured. Every other caller
  that arrives while a run is in flight (a "follower") just waits on
  `c.cond.Wait()` for that same run to finish — it never gets its own
  `ctx` threaded into the fetch at all.
- `internal/api/dashboard.go:21-62` (`handleDashboard`) and `:123-175`
  (`handleDashboardStream`) are the two existing patterns this handler
  sits between: `handleDashboard`'s `?owner=` support, and
  `handleDashboardStream`'s own-dashboard-only restriction (no `?owner=`)
  — this change follows the latter.

## Goals / Non-Goals

**Goals:**

- Let a user trigger an immediate refresh of their own dashboard and see
  the result in the same response, not just eventually via the poll or
  SSE.
- Reuse `Manager.RefreshNow` exactly as it exists — no new refresh
  mechanism, no bypassing the coalescer.

**Non-Goals:**

- Not a per-forge or per-repo scoped refresh — whole-dashboard only, per
  the proposal's confirmed scope decision.
- Not new backend rate-limiting of how often a user can trigger this — the
  existing coalescer already makes concurrent/rapid calls safe; the
  client-side cooldown is about not spamming needless requests, not a
  safety mechanism this depends on.

## Decisions

**The handler passes `deps.AppContext` to `RefreshNow`, not
`r.Context()`.** This is a correction from the original sketch, found by
reading `coalescer.do` directly rather than assuming: if this request
becomes the coalescer's "leader" (the first caller when nothing is
already running) and gets built with `r.Context()`, and the requesting
browser tab then closes or the fetch is aborted, that cancels the _shared_
in-flight refresh — including for the scheduled ticker's own tick or
another tab's own force-refresh click that arrived as a "follower" and is
waiting on this exact same run. Using `deps.AppContext` (the same context
the webhook handler already uses for this reason) keeps a client
disconnecting from ever tearing down a refresh other callers depend on.
The HTTP handler's own response timing is still bounded by
`RefreshNow`/`Aggregator.Refresh` returning, which is itself bounded by
each forge client's own per-request HTTP timeout — no additional
wrapper needed, matching how the scheduled ticker has none either.

**Own-dashboard only, no `?owner=`.** Matches
`handleDashboardStream`'s existing restriction rather than
`handleDashboard`'s. A viewer with shared access to someone else's
dashboard forcing a refresh of it would spend the _owner's_ forge
rate-limit budget on the viewer's own schedule — not something dashboard
sharing was ever meant to grant.

**Cooldown lives entirely in the frontend, not the backend.** The
coalescer already makes a rapid burst of calls safe server-side (they
collapse into at most one trailing run beyond whatever's already in
flight), so a backend rate-limiter would be solving a problem that
doesn't exist. The button disables itself for a few seconds after each
click purely so a user mashing it doesn't fire off a new full-dashboard
`fetch()` on every click for no benefit — a UI courtesy, not a safety
mechanism.

**Response shape matches `handleDashboard`'s own-dashboard branch
exactly**: `200` with the fresh `Snapshot` body on success,
`404` with the same `errorBody(...)` shape `handleDashboardStream` already
uses when `RefreshNow` reports no aggregator running.

## Risks / Trade-offs

- A refresh against a genuinely unreachable forge can take as long as that
  forge client's own HTTP timeout before the response returns, so the
  button stays disabled/"refreshing" for that whole span → Mitigation:
  this is the same latency the scheduled ticker already accepts each
  tick; nothing about this change makes a single refresh pass slower, it
  only changes when one gets triggered.
- Since a force-refresh call can land as a coalescer "follower" behind an
  already-running scheduled tick, the button's own click doesn't always
  correspond to a _new_ fetch starting right then — occasionally it just
  waits out one that was already in flight → Mitigation: this is the
  coalescer's own documented, deliberate guarantee (every caller sees a
  run that started at-or-after its own call), not a bug; the user still
  gets current data either way.

## Migration Plan

New endpoint and new UI only, ships as a normal PR. No data migration, no
existing behavior changed. Rollback is a normal revert.

## Open Questions

None.
