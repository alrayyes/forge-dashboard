# Proposal

## Why

Debugging a live forge-API problem — like #435's rate-limit banner staying
stuck on "resets any moment" — currently means reading `slog` lines that
scroll past in the process's own stdout and are gone once the log rotates,
or reasoning about the wire calls from source code alone. Neither lets
anyone go back after the fact and see exactly which outbound requests this
instance actually made, when, against which forge and account, and what
each one got back. A persisted, queryable log of every outbound forge
request — with a CSV export for taking a slice of it elsewhere — turns a
"reproduce it live or guess" investigation into "pull up the actual
requests."

## What Changes

- Every outbound request `internal/github` and `internal/forgejo` make is
  recorded — timestamp, forge, the account whose credential made it,
  method/endpoint (GraphQL vs REST path), HTTP status, outcome
  (success/`ForgeErrorKind`), and whatever rate-limit fields the response
  carried (limit/remaining/resetsAt/cost, where the forge reports them).
- A new admin-only "Requests" page in the dashboard UI lists the log,
  filterable at least by forge and account, newest first.
- A CSV export of the (filtered) log, downloadable from that page.
- A retention/rotation policy so the log doesn't grow without bound on a
  long-running personal instance.
- **Admin-only, cross-account**: any signed-in account can cause requests
  to be logged, but only an admin can view or export the log — this is
  what makes correlating requests across accounts that might share a
  forge credential possible at all, which single-account visibility
  couldn't do.

## Capabilities

### New Capabilities

- `outbound-request-log`: recording every outbound GitHub/Forgejo request
  the app makes, and an admin-only UI to browse and export that record.

### Modified Capabilities

(none — no existing capability's requirements change; this adds a new
cross-cutting record of behavior that already happens today, it doesn't
change what `internal/github`/`internal/forgejo` do on the wire)

## Impact

- `internal/github/client.go`, `internal/forgejo/client.go` — hook a
  logging call into each outbound request's own success/failure path
  (`graphqlDo`, REST calls, `apiErrorDetail`/`rateLimitFromHeaders`
  equivalents) without changing their existing behavior or return types.
- New package (name TBD in design.md) owning the log's storage and
  retention.
- `internal/api` — new admin-only endpoints: list/query the log, CSV
  export.
- `api/openapi.yaml` — the new endpoints, spec-first per `rules/api.md`.
- `web/src/routes/(app)/admin/` — a new "Requests" page or section.
- `tests/admin.spec.js` (or a new Playwright spec) — journey coverage
  plus the axe-core scan every admin page gets.
- References #435 (the incident that surfaced the need for this).
