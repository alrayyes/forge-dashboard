package api

import (
	"cmp"
	"context"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// defaultReadyProbeTimeout bounds the database ping, under the
	// HEALTHCHECK's own --timeout of 5s so a stuck database answers 503
	// instead of hanging the probe.
	defaultReadyProbeTimeout = 2 * time.Second
	// defaultReadyCacheTTL is how long a ping's result is reused, so probes
	// arriving every second don't each reach the database.
	defaultReadyCacheTTL = 3 * time.Second
)

// Drain flips /readyz to 503 once shutdown starts, before the server stops
// accepting connections, so a router that polls /readyz stops sending
// traffic first. The zero value isn't draining.
type Drain struct{ started atomic.Bool }

// Start marks the server as shutting down. It's safe to call twice.
func (d *Drain) Start() { d.started.Store(true) }

func (d *Drain) active() bool { return d != nil && d.started.Load() }

// readyCache holds the database ping's last result for a short window.
type readyCache struct {
	mu      sync.Mutex
	at      time.Time
	err     error
	checked bool
}

// ping answers the cached result while it's fresh and otherwise pings with
// the probe timeout. Holding the lock across the ping makes concurrent
// probes share one ping instead of each running their own.
func (c *readyCache) ping(ctx context.Context, db DatabasePinger, ttl, timeout time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.checked && time.Since(c.at) < ttl {
		return c.err
	}

	pingCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	c.err = db.PingContext(pingCtx)
	c.at = time.Now()
	c.checked = true

	return c.err
}

// Health matches components.schemas.Health in api/openapi.yaml.
type Health struct {
	Status string `json:"status"`
}

// Ready matches components.schemas.Ready in api/openapi.yaml: Health plus how
// many goroutines and OS threads the process holds (#902).
type Ready struct {
	Status     string `json:"status"`
	Goroutines int    `json:"goroutines"`
	// Threads is left out where the process can't count its own, which is
	// anywhere without /proc.
	Threads int `json:"threads,omitempty"`
}

// threadCount reads Threads: from /proc/self/status, the number the container's
// pids limit counts. A goroutine blocked in a syscall holds a thread, so this
// climbs before the goroutine count does. It answers 0 where it can't be read.
func threadCount() int {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for line := range strings.SplitSeq(string(status), "\n") {
		if value, found := strings.CutPrefix(line, "Threads:"); found {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return 0
			}

			return n
		}
	}

	return 0
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
// refresh is done, 503 with a short fixed reason otherwise, and 503 at once
// once Deps.Drain has started. The reasons are
// constants on purpose: driver errors carry file paths. The real error goes
// to the log. A nil check is skipped, so a Deps with nothing wired stays
// ready.
func handleReady(deps Deps) http.HandlerFunc {
	timeout := cmp.Or(deps.ReadyProbeTimeout, defaultReadyProbeTimeout)
	ttl := cmp.Or(deps.ReadyCacheTTL, defaultReadyCacheTTL)
	cache := &readyCache{}

	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Drain.active() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "shutting down"})

			return
		}
		if deps.Database != nil {
			if err := cache.ping(r.Context(), deps.Database, ttl, timeout); err != nil {
				slog.Warn("readiness: database check failed", "error", err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "database unavailable"})

				return
			}
		}
		if deps.Dashboard != nil && !deps.Dashboard.FirstRefreshComplete() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "first dashboard refresh not complete"})

			return
		}

		writeJSON(w, http.StatusOK, Ready{Status: "ok", Goroutines: runtime.NumGoroutine(), Threads: threadCount()})
	}
}
