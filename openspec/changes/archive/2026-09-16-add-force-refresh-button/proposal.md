## Why

The background refresh (`Aggregator.Run`, `internal/dashboard/aggregator.go`,
every `REFRESH_INTERVAL` — default 5 minutes) is the only thing that
retries a forge today. A `Source`'s `Fetch` never bubbles an error up — a
transient outage (a deploy, a network blip) just shows as an "unreachable"
`ForgeHealth` entry until the next scheduled tick, even though the outage
itself may already be over by then. See
[#219](https://github.com/alrayyes/forge-dashboard/issues/219) for the
acceptance criteria this was built against.

## What Changes

- A new `POST /api/dashboard/refresh` endpoint, own-dashboard only (no
  `?owner=` support, unlike `GET /api/dashboard`), calling the existing
  `Manager.RefreshNow(ctx, userID)` (`internal/dashboard/manager.go`) —
  already coalescer-safe, currently only reachable from the webhook
  handler. Returns the fresh snapshot on success, 404 if no aggregator is
  running yet for that user (no credentials saved).
- A button next to the existing "Refreshed Xs ago" label
  (`#refreshed-at`), disabled for a short cooldown after each click, that
  calls the new endpoint and applies the response through the existing
  `applySnapshot()`.
- **BREAKING**: none — a new endpoint and new UI only.

## Capabilities

### New Capabilities

- `dashboard-force-refresh`: lets a signed-in user trigger an immediate
  refresh of their own dashboard, out of band from the scheduled
  background poll.

### Modified Capabilities

None.

## Impact

- `internal/api/dashboard.go` — new `handleDashboardRefresh` handler.
- `internal/api/server.go` — route registration alongside the existing
  `GET /api/dashboard` and `GET /api/dashboard/stream`.
- `api/openapi.yaml` — new path; `bun run lint:api` must still pass.
- `internal/api/static/index.html` — the button, next to `#refreshed-at`.
- `internal/api/static/app.js` — click handler, cooldown, applying the
  response snapshot, error-banner handling on failure.
- `internal/api/static/style.css` — styling for the button.
- Tests: `go test ./...` for the new handler (own-dashboard-only, 404 with
  no aggregator, success returns the snapshot); `bunx playwright test` for
  the button's click/cooldown/error behavior and that it's absent when
  viewing a shared dashboard.
