package api

import (
	"context"
	"log/slog"
	"net/http"
)

// Health matches components.schemas.Health in api/openapi.yaml.
type Health struct {
	Status string `json:"status"`
}

// handleHealth answers 200 once the process has started — see the
// operation description in api/openapi.yaml for what it deliberately
// doesn't check.
func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, Health{Status: "ok"})
}

// Version matches components.schemas.Version in api/openapi.yaml.
type Version struct {
	Version string `json:"version"`
}

// handleVersion answers the release tag this binary was built from —
// public and unauthenticated, same as /healthz, so the pre-login page can
// link to it too.
func handleVersion(version string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, Version{Version: version})
	}
}

// DatabasePinger is the slice of *sql.DB readiness needs. Deps.Database is
// satisfied by cmd/forge-dashboard's schema-aware wrapper in production.
type DatabasePinger interface {
	PingContext(ctx context.Context) error
}

// FirstRefreshGate reports whether the dashboard has finished its first
// refresh. *dashboard.Manager satisfies it.
type FirstRefreshGate interface {
	FirstRefreshComplete() bool
}

// handleReady answers 200 when the database answers and the first dashboard
// refresh is done, 503 with a short fixed reason otherwise. The reasons are
// constants on purpose: driver errors carry file paths. The real error goes
// to the log. A nil check is skipped, so a Deps with nothing wired stays
// ready.
func handleReady(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Database != nil {
			if err := deps.Database.PingContext(r.Context()); err != nil {
				slog.Warn("readiness: database check failed", "error", err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "database unavailable"})

				return
			}
		}
		if deps.Dashboard != nil && !deps.Dashboard.FirstRefreshComplete() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "first dashboard refresh not complete"})

			return
		}

		writeJSON(w, http.StatusOK, Health{Status: "ok"})
	}
}
