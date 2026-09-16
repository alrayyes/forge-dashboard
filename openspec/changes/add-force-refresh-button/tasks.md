## 1. API schema

- [x] 1.1 Add a `POST /api/dashboard/refresh` path to `api/openapi.yaml` (`operationId: refreshDashboard`), following `GET /api/dashboard/stream`'s own-dashboard-only pattern (no `owner` parameter) and `GET /api/dashboard`'s response shape: `200` with `#/components/schemas/Dashboard`, `401` and `404` (no aggregator running, mirroring `GET /api/dashboard/stream`'s 404) with `#/components/schemas/Error`; verify `bun run lint:api` passes.

## 2. Backend handler

- [x] 2.1 Add `handleDashboardRefresh(deps Deps) http.HandlerFunc` to `internal/api/dashboard.go`, modeled on `handleDashboardStream`'s auth/own-dashboard-only shape: resolve the signed-in user, call `deps.Manager.RefreshNow(deps.AppContext, u.ID)` — `deps.AppContext`, not `r.Context()`, per design.md's Decisions — and on `true` respond `200` with `deps.Manager.Get(u.ID)`, on `false` respond `404` with `errorBody("no background refresh is running yet for this user")`, matching `handleDashboardStream`'s own message.
- [x] 2.2 Register `POST /api/dashboard/refresh` in `internal/api/server.go` alongside the existing `GET /api/dashboard` and `GET /api/dashboard/stream` registrations, behind `auth.RequireAuth`.
- [x] 2.3 `go test ./...` coverage in `internal/api`: a successful refresh returns the fresh snapshot; no aggregator running returns 404; unauthenticated returns 401 (matching the existing pattern for the other dashboard handlers' tests).

## 3. Frontend: the button

- [x] 3.1 Add a refresh button next to `#refreshed-at` in `internal/api/static/index.html`.
- [x] 3.2 Wire it in `internal/api/static/app.js`: on click, disable the button, `POST /api/dashboard/refresh`, apply the response through the existing `applySnapshot()`, re-enable after a short cooldown (a few seconds) whether the request succeeded or failed; on a non-2xx response, surface it through the existing `showError()` instead of applying anything.
- [x] 3.3 Style the button in `internal/api/static/style.css`, including its disabled/cooldown state, following the existing `.theme-toggle`-style icon-button visual language already used for the other header controls.
- [x] 3.4 Confirm the button is absent (or inert) when viewing a shared dashboard (`?owner=` set) — it must never be reachable for anything but the signed-in user's own dashboard.

## 4. Tests

- [x] 4.1 `bunx playwright test` coverage in `tests/dashboard.spec.js`: clicking the button calls the endpoint and the dashboard updates from its response; the button is disabled immediately after a click and re-enabled after the cooldown; a 404 response (mock a fresh user with nothing saved) shows the existing error banner rather than a silent failure; the button has no effect (or isn't present) when viewing a shared dashboard.
- [x] 4.2 `bunx playwright test`'s existing axe-core checks still pass with the new button rendered (extend an existing accessibility test rather than adding a redundant one, if one already covers this part of the header).
- [x] 4.3 Run the full suite (`bunx playwright test`, `bun run lint:js`, `go test ./...`, `bun run lint:api`) across all touched files and fix any regression before considering the change done.
