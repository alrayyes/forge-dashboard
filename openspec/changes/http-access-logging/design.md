# Design

## Context

See proposal.md - Why. `NewMux` (`internal/api/server.go`) registers every route directly with no wrapping middleware at all today. `auth.RequireAuth` already exists as a per-route wrapper (`auth.RequireAuth(deps.AuthStore)(handler)`), applied selectively per handler — this change adds a second wrapper applied once, around the whole mux, not per-route.

## Goals / Non-Goals

**Goals:**

- One log line per completed request, at a level that reflects its actual outcome.
- No credential or secret ever reaches the log output.

**Non-Goals:**

- No request tracing/correlation IDs, no OpenTelemetry integration — out of scope for a personal-scale tool with no distributed tracing infrastructure to feed.
- No sampling/rate-limiting of the log output itself — request volume here is low enough that every request logging is not a cost concern.

## Decisions

**Capture status via a wrapped `ResponseWriter`, not `httptest`.** `http.ResponseWriter` never exposes what status a handler actually wrote. A small `statusRecorder` struct embedding `http.ResponseWriter` and overriding `WriteHeader` to record the code (defaulting to 200 if `WriteHeader` is never called explicitly, matching `net/http`'s own default) is the standard, dependency-free way to get it — used instead of a third-party logging-middleware package, consistent with this project's stdlib-first Go convention.

**Wrap outside `auth.RequireAuth`, applied once to the whole `http.ServeMux`, not per-route.** Every other route wrapper in this codebase (`auth.RequireAuth`, `auth.RequireAdmin`) is applied selectively per-handler in `NewMux`'s registration calls. Access logging is different: it has to see every request including ones auth rejects, so it wraps the mux's `ServeHTTP` itself — `logging(mux)` returned from `NewMux`, not threaded into each `mux.Handle` call.

**Level selection is a pure function of the final status code**, computed after the handler runs, not decided per-handler. Keeps every route's logging behavior automatically consistent with no per-handler opt-in required, and matches this codebase's existing `slog` level conventions rather than inventing a new one specific to this middleware.

## Risks / Trade-offs

- **A panic inside a handler would bypass the deferred log line** if nothing recovers first. → Mitigation: this middleware's own deferred logging function should itself be positioned to run via `defer` before any panic-recovery wrapper, or after one if a recovery wrapper already exists — check whether `NewMux`/`main.go` already has panic recovery; if not, this is a pre-existing gap this change doesn't need to fix but shouldn't make worse.
- **`/healthz` still needs _some_ visibility if it starts failing** (e.g. a liveness probe genuinely can't reach the server). → Mitigation: downgrading it to Debug rather than fully excluding it keeps that path available if `LOG_LEVEL=debug` is ever set for diagnosis, without polluting the default Info-level output.

## Migration Plan

Additive only — no schema, no config change, no behavior change to any handler's own response. Ships enabled by default; nothing to migrate or roll back beyond reverting the wrapper.
