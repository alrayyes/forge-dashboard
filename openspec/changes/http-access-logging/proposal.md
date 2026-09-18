# Proposal

## Why

No inbound HTTP request is logged anywhere today — only scattered per-handler event logging and outbound-call tracing exist, leaving no basic operational visibility into what the server is actually serving. See [alrayyes/forge-dashboard#371](https://github.com/alrayyes/forge-dashboard/issues/371).

## What Changes

- A single middleware wraps the whole mux in `NewMux`, outside `auth.RequireAuth`, logging one structured line per completed request.
- Log level follows the response status: 5xx → Error, 4xx → Warn, everything else → Info.
- Logged fields: method, path, status, duration, remote address, and the signed-in username once auth resolves — plain flat names (`method`, `path`, `status`, `duration_ms`, `remote_addr`) matching this codebase's existing `slog` style.
- `/healthz` is logged at Debug (or excluded), not Info, so liveness-probe traffic doesn't drown out real activity.
- Never logs the `Authorization`/`Cookie` header, the raw query string, or request/response bodies.

## Capabilities

### New Capabilities

- `http-access-logging`: structured, per-request logging of every inbound HTTP request, at a level determined by its outcome.

### Modified Capabilities

(none)

## Impact

- `internal/api/server.go`: `NewMux` gains a wrapping middleware.
- No API surface change, no new dependency (no HTTP router/framework is in use; a small hand-written `http.Handler` wrapper is the natural fit).
