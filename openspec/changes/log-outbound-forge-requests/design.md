# Design

## Context

See proposal.md - Why. `internal/github/client.go` and
`internal/forgejo/client.go` each already classify every outbound
request's outcome into a `dashboard.ForgeErrorKind` and, for GitHub,
already extract rate-limit fields from the response
(`rateLimitFromHeaders`, the GraphQL `rateLimit` query field). None of
that is persisted today — it either becomes part of the returned
`dashboard.Result`/`ForgeHealth` for that one poll, or it's a `slog` line
that scrolls away. `internal/auth/store.go` already owns a SQLite
database (`Store.Init`, `CREATE TABLE IF NOT EXISTS ...`) for
users/sessions/tokens/invites — the natural home for another table,
rather than standing up a second storage mechanism for one more record
type. `internal/dashboard/manager.go`'s `Manager` runs one `Aggregator`
per account, each with its own forge client instances, so "the account
whose credential made the request" is already known at the call site
inside each client — it just isn't threaded anywhere past the client
today.

## Goals / Non-Goals

**Goals:**

- Every outbound GitHub/Forgejo request produces exactly one log entry,
  with no change to that request's own success/failure behavior.
- An admin can see requests made under any account's credential, since
  correlating a shared-credential problem (like #435's suspected cause)
  needs a cross-account view no single account's own session gives.

**Non-Goals:**

- No change to what `ForgeHealth`/`RateLimit` report to the dashboard UI
  itself — this is a separate, persisted record alongside that, not a
  replacement for it.
- No real-time streaming view of the log (e.g. live-tailing over SSE) —
  a list that refreshes like any other admin table is enough for
  after-the-fact debugging; this can be added later without a spec
  change if it turns out to be wanted.
- No attempt to reconstruct or backfill history from existing `slog`
  output — the log starts recording from when this change ships forward.

## Decisions

**One `request_log` table in the existing auth SQLite database**, not a
new database or an external logging service. Reuses `internal/auth.Store`'s
existing connection and migration pattern (`CREATE TABLE IF NOT EXISTS`)
rather than introducing a second storage mechanism for a personal-project
instance that already has one. Columns: `id`, `logged_at`, `forge`,
`account_id` (nullable — a request made with no per-account credential,
if that ever exists, still gets logged), `method`, `endpoint`,
`status_code`, `outcome` (`success` or a `ForgeErrorKind` string),
`rate_limit_limit`/`rate_limit_remaining`/`rate_limit_resets_at`/`rate_limit_cost`
(all nullable — not every request reports these).

**A small `requestlog.Recorder` interface, owned by the caller
(`internal/dashboard`), implemented by a new `internal/requestlog`
package** — per `rules/go.md`'s "define interfaces in the consuming
package." `internal/github` and `internal/forgejo` each accept a
`Recorder` (one or two methods: record a completed request) at
construction, the same way they already take a token/username. Neither
forge package imports the other's, and neither imports
`internal/requestlog`'s concrete store type — only the interface,
defined where it's consumed, matching this repo's existing pattern for
`dashboard.RateLimiter`/`dashboard.RepoRefresher`.

**Recording happens synchronously but never blocks or fails the
request** — the design in `graphqlDo`/the forgejo client's own request
wrapper calls `Recorder.Record` right where `apiErrorDetail`/the
REST-error path already builds its classification, and any error from
recording is logged with `slog.Warn` and otherwise swallowed, per the
spec's own requirement. No queue or async writer: SQLite writes are fast
enough at this request volume (one instance, a handful of accounts,
polling every few minutes) that a background worker would be complexity
without a real throughput problem to solve.

**Retention by row count, trimmed on write** — after inserting a new row,
delete the oldest rows past a fixed cap (e.g. 10,000 entries) in the same
transaction. Simpler than a time-based sweep needing its own scheduled
job, and bounds storage regardless of how bursty traffic gets.

**Admin-only, cross-account, via the existing `auth.RequireAdmin`
middleware** — the same composition `internal/api/admin.go`'s other
handlers already use (`auth.RequireAuth(store)(auth.RequireAdmin(...))`).
The list/query endpoint takes optional `forge`/`account` filter query
params; the CSV export endpoint takes the same filters and streams
`text/csv` instead of JSON, mirroring the shape of GitHub's own CSV
export endpoints (content-disposition attachment, one header row).

**UI: a new "Requests" section on the existing admin page**
(`web/src/routes/(app)/admin/+page.svelte`), not a standalone route —
it's another admin-only table alongside Users/Invites, following that
same fetch-and-render pattern, with a filter row and an "Export CSV"
link/button that hits the export endpoint directly (a plain navigation
to a same-origin authenticated URL, the standard way to trigger a file
download from an already-authenticated session).

## Risks / Trade-offs

- **A busy instance could still write a lot of rows between retention
  trims.** → Mitigation: the row cap is a real ceiling checked on every
  insert, not a periodic job that could fall behind; worst case is
  briefly holding slightly more than the cap between the insert and its
  own trim, never unbounded growth.
- **Logging every request adds a write to the hot poll path.** →
  Mitigation: SQLite is already this app's own database for
  auth/session data on every request; one more small insert per outbound
  forge call, at this instance's actual request volume, is not a
  meaningful cost. If it ever is, `Recorder.Record` is the single seam
  to make it async without touching either forge client.
- **A CSV export of a large, unfiltered log could be slow to generate.**
  → Mitigation: the same row cap that bounds storage also bounds the
  largest possible export; no separate pagination needed at this scale.

## Migration Plan

Additive only — a new table, a new interface both forge clients accept
with a concrete implementation wired in at the composition root
(`cmd/forge-dashboard/main.go`), new admin-only endpoints, and a new UI
section. No existing behavior, schema, or endpoint changes. Nothing to
roll back beyond reverting the change; no data migration since the log
starts empty and fills in going forward.
